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
import { getLogger } from '../logger.js';
import {
  looksLikeCreds,
  quarantineSession,
  RecoveryOutcome,
  type RecoveryOutcomeValue,
} from './sessionRecovery.js';

export interface AtomicAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Destroy every file for this instance. Used on logout — see §4.1. */
  clear: () => Promise<void>;
  /** True when credentials were loaded from disk rather than freshly minted. */
  restored: boolean;
  /** Exactly what happened on load — see architecture §13.2. */
  outcome: RecoveryOutcomeValue;
  /** Where a quarantined session was preserved, when outcome is QUARANTINED. */
  quarantinePath: string | undefined;
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
 * One generation of backup, and only one.
 *
 * Atomic writes already make a torn creds.json impossible, so this covers what
 * they cannot: filesystem-level corruption, a bad sector, an operator editing
 * the volume by hand. Keeping more generations would turn the volume into an
 * archive of account credentials — every extra copy is another place a full
 * WhatsApp session can leak from, for a diagnostic return that drops sharply
 * after the immediately-previous version.
 */
const BACKUP_FILE = 'creds.json.bak';

/**
 * Open (or create) the auth state for one instance directory.
 *
 * `dir` must already have been resolved through `sessionDirFor`, which is what
 * validates the instance id. This function does not re-derive it — one place
 * owns that check.
 */
export async function useAtomicFileAuthState(
  dir: string,
  quarantineRoot: string,
): Promise<AtomicAuthState> {
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

  // ── Load credentials, following architecture §13.2 ────────────────────────
  //
  // The three outcomes are kept strictly apart because conflating them is how a
  // working pairing gets destroyed: a corrupt file treated as "first run" mints
  // fresh credentials, and the next `creds.update` writes them over the only
  // copy that might still have been recoverable.
  const credsPath = path.join(dir, CREDS_FILE);
  const backupPath = path.join(dir, BACKUP_FILE);

  const credsExisted = await exists(credsPath);
  const primary = await readData<AuthenticationCreds>(CREDS_FILE);

  let creds: AuthenticationCreds;
  let outcome: RecoveryOutcomeValue;
  let quarantinePath: string | undefined;

  if (!credsExisted) {
    creds = initAuthCreds();
    outcome = RecoveryOutcome.FRESH;
  } else if (primary !== null && looksLikeCreds(primary)) {
    creds = primary;
    outcome = RecoveryOutcome.RESTORED;
  } else {
    // creds.json exists but is unparseable, or parsed into something that is
    // not a credential set. Try the one-generation backup before giving up.
    const backupExists = await exists(backupPath);
    const backup = backupExists ? await readData<AuthenticationCreds>(BACKUP_FILE) : null;

    if (backup !== null && looksLikeCreds(backup)) {
      creds = backup;
      outcome = RecoveryOutcome.RESTORED_FROM_BACKUP;
      getLogger().warn(
        { session_dir: dir, operation: 'session.recover' },
        'creds_restored_from_backup — primary credentials were unusable',
      );
      // Promote the backup to primary immediately. Leaving the bad file in
      // place would mean re-running this recovery on every restart, and a
      // second corruption would then have no backup left to fall back to.
      await atomicWriteFile(credsPath, JSON.stringify(creds, BufferJSON.replacer));
    } else {
      // Both copies are gone. Preserve the directory rather than delete it —
      // it is the only artefact that explains what happened (§13.2).
      quarantinePath = await quarantineSession(dir, quarantineRoot, path.basename(dir));
      creds = initAuthCreds();
      outcome = RecoveryOutcome.QUARANTINED;
    }
  }

  const restored =
    outcome === RecoveryOutcome.RESTORED || outcome === RecoveryOutcome.RESTORED_FROM_BACKUP;

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

  /**
   * Persist credentials, rotating the previous copy into `creds.json.bak`.
   *
   * The order is load-bearing. The backup is written from the CURRENT on-disk
   * bytes *before* the new credentials replace them, so at every instant at
   * least one valid copy exists:
   *
   *   crash before the backup write  → creds.json intact (old)
   *   crash between the two          → creds.json intact (old), .bak == old
   *   crash during the creds write   → atomic rename means creds.json is still
   *                                    old, and .bak is old. Never both torn.
   *
   * Doing it the other way round — new creds first, then backup — would leave a
   * window where creds.json is new and .bak still holds a version two
   * generations back, which is the copy least likely to be useful.
   *
   * A failed backup never blocks the credential write: losing the safety net is
   * bad, losing the credentials themselves is worse.
   */
  const saveCreds = async (): Promise<void> => {
    try {
      const current = await readFile(credsPath, 'utf8');
      await atomicWriteFile(backupPath, current);
    } catch {
      /* no previous creds to back up, or the copy failed — proceed regardless */
    }
    await writeData(creds, CREDS_FILE);
  };

  return {
    state,
    restored,
    outcome,
    quarantinePath,
    saveCreds,
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
