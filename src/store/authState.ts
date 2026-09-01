// Baileys authentication state, persisted atomically (architecture §4.2).
//
// ── Why this is not `useMultiFileAuthState` ────────────────────────────────
//
// Baileys ships that helper, and its own doc comment says:
//
//     "I wouldn't endorse this for any production level use other than perhaps
//      a bot. Would recommend writing an auth state for use with a proper SQL
//      or No-SQL DB"
//
// We are not using a database (architecture §12.1 explains why), so the answer
// is to write the file-backed store properly rather than to accept a helper its
// own authors flag as unsuitable. Three concrete differences, each of which is
// a real failure this service would otherwise inherit:
//
//   1. It calls `writeFile` directly. A container killed mid-write leaves
//      truncated JSON, and a truncated creds.json is an unrecoverable session
//      — the exact failure §13.2 exists to prevent. We write temp + fsync +
//      rename, so a kill at any instant leaves either the old file or the new
//      one, never half of either.
//
//   2. It keeps a module-level `Map` of one mutex per file path, and never
//      evicts. Pre-key files are created and deleted constantly, so that map
//      grows for the life of the process, across every instance. We use one
//      serializer per instance instead — bounded by the number of instances,
//      which is already bounded by WA_MAX_INSTANCES.
//
//   3. Its `fixFileName` maps `/` and `:` out of the way but does not refuse
//      `..`, and does not bound the filename length. Signal ids embed remote
//      JIDs, which are attacker-influenced: a peer chooses its own identifier.
//      We validate the result and refuse anything that could traverse.

import { unlink, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { initAuthCreds, BufferJSON, proto } from 'baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
} from 'baileys';
import { atomicWriteFile, ensureDir, exists } from './paths.js';
import { GatewayError } from '../errors.js';

export interface AtomicAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Destroy every file for this instance. Used on logout — see §4.1. */
  clear: () => Promise<void>;
  /** True when credentials were loaded from disk rather than freshly minted. */
  restored: boolean;
}

/**
 * Longest filename we will produce.
 *
 * Most filesystems cap a single component at 255 bytes. A `sender-key` id
 * concatenates a group JID and a participant JID and can approach that; going
 * over produces ENAMETOOLONG, which surfaces as a session that silently stops
 * persisting one key type. Anything longer is truncated and disambiguated with
 * a hash of the full id, which keeps the mapping injective.
 */
const MAX_FILENAME = 180;

/**
 * Map a Signal id to a safe filename.
 *
 * The `/` → `__` and `:` → `-` substitutions match Baileys' own helper, so an
 * existing session directory written by `useMultiFileAuthState` is still
 * readable by this one — that compatibility is deliberate, since it is the
 * difference between swapping the implementation and forcing every studio to
 * re-scan.
 *
 * Everything after those two lines is the hardening Baileys' version lacks.
 */
export function safeFileName(raw: string): string {
  const replaced = raw.replace(/\//g, '__').replace(/:/g, '-');

  // Refuse rather than sanitise. A silently-rewritten key id would be written
  // to one path and read back from another, which presents as a session that
  // pairs and then immediately fails to decrypt.
  if (
    replaced.length === 0 ||
    replaced.includes('/') ||
    replaced.includes('\\') ||
    replaced.includes('\0') ||
    replaced === '.' ||
    replaced === '..' ||
    replaced.startsWith('..')
  ) {
    throw GatewayError.internal('Refusing an unsafe auth-state filename.');
  }

  if (replaced.length <= MAX_FILENAME) return replaced;

  const digest = createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 16);
  return `${replaced.slice(0, MAX_FILENAME - digest.length - 1)}-${digest}`;
}

/** Serialises writes for one instance. Bounded, unlike a per-path map. */
function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

const CREDS_FILE = 'creds.json';

/**
 * Open (or create) the auth state for one instance directory.
 *
 * `dir` must already have been resolved through `sessionDirFor`, which is what
 * validates the instance id. This function does not re-derive it — one place
 * owns that check.
 */
export async function useAtomicFileAuthState(dir: string): Promise<AtomicAuthState> {
  await ensureDir(dir);
  const serialize = createSerializer();

  const fileFor = (name: string): string => path.join(dir, safeFileName(name));

  const writeData = (data: unknown, name: string): Promise<void> =>
    serialize(() => atomicWriteFile(fileFor(name), JSON.stringify(data, BufferJSON.replacer)));

  const readData = async <T>(name: string): Promise<T | null> => {
    try {
      const raw = await readFile(fileFor(name), 'utf8');
      return JSON.parse(raw, BufferJSON.reviver) as T;
    } catch {
      // Deliberately swallows BOTH a missing file and unparseable JSON, and
      // returns null so Baileys treats the key as absent.
      //
      // For a KEY that is correct: a lost pre-key is renegotiated. For CREDS it
      // would not be — but the caller below checks whether creds.json exists on
      // disk separately, so a corrupt creds file is detected there rather than
      // being mistaken for a first run. See `restored`.
      return null;
    }
  };

  const removeData = async (name: string): Promise<void> => {
    try {
      await unlink(fileFor(name));
    } catch {
      /* already gone */
    }
  };

  const credsExisted = await exists(path.join(dir, CREDS_FILE));
  const loaded = await readData<AuthenticationCreds>(CREDS_FILE);
  const creds: AuthenticationCreds = loaded ?? initAuthCreds();

  // `restored` distinguishes three situations the connector must tell apart:
  // no file at all (first pairing), a file that loaded (reconnect, no QR), and
  // a file that exists but did not parse (corruption — Phase 4 quarantines it).
  const restored = credsExisted && loaded !== null;

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        await Promise.all(
          ids.map(async (id) => {
            let value = await readData<SignalDataTypeMap[T]>(`${type}-${id}.json`);
            if (type === 'app-state-sync-key' && value) {
              // Baileys requires this one type rehydrated into its protobuf
              // wrapper; a plain object silently fails app-state decryption.
              //
              // The double cast is unavoidable: `type` is narrowed to the
              // literal here but `T` is not, so TypeScript still expects the
              // union of every value type. This is the same runtime behaviour
              // as Baileys' own helper, which is untyped at this point.
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as object,
              ) as unknown as SignalDataTypeMap[T];
            }
            if (value !== null) out[id] = value;
          }),
        );
        return out;
      },
      set: async (data: SignalDataSet) => {
        const tasks: Promise<void>[] = [];
        for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
          const entries = data[category];
          if (!entries) continue;
          for (const id of Object.keys(entries)) {
            const value = entries[id];
            const name = `${category}-${id}.json`;
            tasks.push(value ? writeData(value, name) : removeData(name));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    restored,
    saveCreds: () => writeData(creds, CREDS_FILE),
    /**
     * Remove every file in the instance directory.
     *
     * The directory itself is kept so the instance can immediately re-pair into
     * it without a race against `ensureDir`. Called on logout, where WhatsApp
     * has already invalidated the device — retrying with dead credentials is
     * how an account gets flagged (§5.1).
     */
    clear: async () => {
      await serialize(async () => {
        const { readdir } = await import('node:fs/promises');
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return;
        }
        await Promise.all(
          names.map((name) => unlink(path.join(dir, name)).catch(() => undefined)),
        );
      });
    },
  };
}
