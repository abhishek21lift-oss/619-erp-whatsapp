// Corrupted-session detection, quarantine and retention (architecture §13.2).
//
// ── The failure this exists to prevent ──────────────────────────────────────
//
// Before Phase 4 an unparseable creds.json was swallowed and fresh credentials
// were minted in its place. That reads as harmless — until you follow it
// through: a studio that was paired appears `never_connected`, the owner is
// invited to scan a new QR, and the first `creds.update` after that overwrites
// the only copy of the session that might still have been recoverable. A
// transient read error would have silently destroyed a working pairing.
//
// So corruption is now detected, distinguished from a first run, recovered from
// a backup where possible, and otherwise preserved rather than deleted.

import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { getLogger } from '../logger.js';

/** What happened when an instance's credentials were loaded. */
export const RecoveryOutcome = {
  /** No creds file. A first pairing — the normal path for a new instance. */
  FRESH: 'fresh',
  /** creds.json parsed and carries a device identity. */
  RESTORED: 'restored',
  /** creds.json was unusable; creds.json.bak was good. */
  RESTORED_FROM_BACKUP: 'restored_from_backup',
  /** Both were unusable. The directory was preserved and fresh creds minted. */
  QUARANTINED: 'quarantined',
} as const;

export type RecoveryOutcomeValue = (typeof RecoveryOutcome)[keyof typeof RecoveryOutcome];

/**
 * Does this object actually look like WhatsApp credentials?
 *
 * `JSON.parse` succeeding is not enough — the architecture's flow says
 * "parses **and has a device identity**". An empty object, `null`, or a
 * truncated write that happens to land on valid JSON all parse fine and would
 * then be handed to Baileys as a session, which fails much later and much less
 * legibly than failing here.
 *
 * Checks the three fields that cannot be absent from a real credential set: the
 * Noise handshake key, the signed identity key, and the registration id. It is
 * deliberately a shape check, not a cryptographic one — the goal is to separate
 * "corrupt" from "valid", not to detect a forged session, which is not a threat
 * on a 0700 directory only this process can read.
 */
export function looksLikeCreds(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const creds = value as Record<string, unknown>;

  const hasKeyPair = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null) return false;
    const pair = v as Record<string, unknown>;
    // After BufferJSON.reviver these are Buffers; before it they would be
    // {type:'Buffer',data:[…]}. Accepting both means a hand-inspected file
    // does not read as corrupt.
    const isBytes = (b: unknown) =>
      Buffer.isBuffer(b) || b instanceof Uint8Array || (typeof b === 'object' && b !== null);
    return isBytes(pair['private']) && isBytes(pair['public']);
  };

  return (
    hasKeyPair(creds['noiseKey']) &&
    hasKeyPair(creds['signedIdentityKey']) &&
    typeof creds['registrationId'] === 'number'
  );
}

/**
 * Move a session directory aside, preserving it for diagnosis.
 *
 * Deleting would destroy the only artefact that explains what happened, and
 * "the session broke and we threw away the evidence" is not an incident report.
 *
 * `rename` first because it is atomic and instant when both paths are on the
 * same filesystem, which under /data they are. The copy fallback exists for a
 * deployment that mounts the quarantine directory elsewhere — there the move is
 * not atomic, so the copy is completed before the original is removed: a crash
 * mid-way leaves two copies, which is recoverable, rather than none.
 *
 * Returns the quarantine path, or undefined when there was nothing to move.
 */
export async function quarantineSession(
  sessionDir: string,
  quarantineRoot: string,
  instanceId: string,
): Promise<string | undefined> {
  const log = getLogger();

  try {
    const entries = await readdir(sessionDir);
    if (entries.length === 0) return undefined;
  } catch {
    return undefined; // nothing there to preserve
  }

  // ISO timestamps have millisecond resolution, and two quarantines of the same
  // instance CAN land in the same millisecond — a restore sweep retrying, or a
  // reconnect immediately after a failure. Without the random suffix both
  // resolve to one directory: `rename` onto a non-empty one throws, and the
  // copy fallback would then merge two sessions' evidence into a single folder,
  // which is worse than losing one of them because it looks intact.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const unique = randomBytes(3).toString('hex');
  const target = path.join(path.resolve(quarantineRoot), `${instanceId}-${stamp}-${unique}`);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });

  try {
    await rename(sessionDir, target);
  } catch {
    await cp(sessionDir, target, { recursive: true });
    await rm(sessionDir, { recursive: true, force: true });
  }

  // Recreate the (now empty) session directory so the instance can re-pair
  // straight into it without racing an mkdir.
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });

  log.warn(
    { instance_id: instanceId, quarantine_path: target, operation: 'session.quarantine' },
    'session_quarantined',
  );
  return target;
}

/**
 * Delete quarantined sessions older than the retention window.
 *
 * These directories hold real WhatsApp credentials — dead ones, but a device
 * identity all the same. Keeping them forever turns the volume into an archive
 * of every session that ever broke, which is a growing liability for a
 * diminishing diagnostic return: nobody investigates a three-month-old
 * disconnect, and WhatsApp has long since invalidated the keys anyway.
 *
 * Never throws. A sweep failure must not stop a boot.
 */
export async function sweepQuarantine(
  quarantineRoot: string,
  retentionDays: number,
  now = Date.now(),
): Promise<{ removed: number; kept: number }> {
  const log = getLogger();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;

  let entries: string[];
  try {
    entries = await readdir(quarantineRoot);
  } catch {
    return { removed: 0, kept: 0 }; // nothing quarantined yet
  }

  let removed = 0;
  let kept = 0;

  for (const entry of entries) {
    const target = path.join(quarantineRoot, entry);
    try {
      const info = await stat(target);
      if (info.mtimeMs < cutoff) {
        await rm(target, { recursive: true, force: true });
        removed += 1;
      } else {
        kept += 1;
      }
    } catch (err) {
      // One unreadable entry must not abort the sweep for the rest.
      log.warn(
        { err: (err as Error).message, entry, operation: 'session.sweep' },
        'quarantine_sweep_entry_failed',
      );
    }
  }

  if (removed > 0) {
    log.info({ removed, kept, operation: 'session.sweep' }, 'quarantine_swept');
  }
  return { removed, kept };
}
