// Filesystem safety for session storage (architecture §4.2).
//
// Everything in this file exists to make two guarantees:
//
//   1. An instance id can never escape the session root. The defence is
//      validating the id BEFORE it touches a path, not sanitising a path
//      afterwards — `path.join` happily resolves `../../etc`, and every
//      after-the-fact sanitiser is a blocklist waiting to be bypassed.
//
//   2. A write is never half-applied. A container killed mid-write to
//      creds.json otherwise leaves truncated JSON, which is the single most
//      common way a Baileys session becomes unrecoverable.

import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { open, mkdir, rename, unlink, access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { GatewayError } from '../errors.js';

/**
 * RFC 4122 UUID, versions 1–8, canonical hyphenated form.
 *
 * The backend mints these with Postgres `gen_random_uuid()` and this service
 * with `crypto.randomUUID()`, both of which produce v4 — so v4 is what will
 * actually be seen. The pattern deliberately accepts any version anyway,
 * because the property that matters here is the CHARACTER CLASS: `[0-9a-f-]`
 * cannot express `.`, `/` or a null byte, so no accepted id can traverse.
 * Pinning the version would add brittleness for a security gain of exactly
 * zero.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Throws a 400 rather than returning false — callers must not proceed. */
export function assertUuid(value: unknown, field: string): string {
  if (!isUuid(value)) {
    throw GatewayError.validation(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

/**
 * The directory holding one instance's Baileys auth state.
 *
 * Validates, then joins, then re-checks containment. The third step is
 * redundant given the first — and is kept anyway, because it costs a string
 * comparison and it is the check that would still hold if UUID_RE were ever
 * loosened by someone who did not read the comment above it.
 */
export function sessionDirFor(sessionRoot: string, instanceId: string): string {
  const id = assertUuid(instanceId, 'instance_id');
  const root = path.resolve(sessionRoot);
  const dir = path.resolve(root, id);

  if (dir !== path.join(root, id)) {
    throw GatewayError.internal('Refusing to resolve a session path outside the session root.');
  }
  return dir;
}

/** `mkdir -p` with 0700 — a volume snapshot is the realistic leak path. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file atomically: temp file in the SAME directory, fsync, rename.
 *
 * Same directory because `rename` is only atomic within a filesystem, and
 * /tmp may well be a different one. fsync before the rename because a rename
 * that lands before the data is flushed gives you an atomically-swapped-in
 * empty file — durable, and wrong.
 *
 * The directory handle is fsynced afterwards so the rename itself survives a
 * power loss. On platforms where opening a directory for fsync is not
 * permitted this is skipped rather than failed: the file content is already
 * safe at that point, and refusing the whole write would be a worse outcome
 * than a slightly weaker durability guarantee on the metadata.
 */
export async function atomicWriteFile(
  filePath: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);

  let handle;
  try {
    handle = await open(tmpPath, 'wx', mode);
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle?.close();
  }

  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }

  let dirHandle;
  try {
    dirHandle = await open(dir, 'r');
    await dirHandle.sync();
  } catch {
    /* see the comment above — content is already durable */
  } finally {
    await dirHandle?.close().catch(() => undefined);
  }
}

/**
 * Read and parse JSON, or return undefined when the file is absent.
 *
 * A MISSING file and an UNPARSEABLE one are different situations and must not
 * collapse into the same answer: missing means "never connected", unparseable
 * means "corrupted, quarantine it" (architecture §13.2). So absence returns
 * undefined and a parse failure throws.
 */
export async function readJsonIfExists<T>(filePath: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(raw) as T;
}
