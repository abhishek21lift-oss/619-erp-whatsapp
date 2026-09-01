// Corrupted-session recovery, quarantine and retention (architecture §13.2).
//
// ── The regression these exist to prevent ──────────────────────────────────
//
// Before Phase 4 an unparseable creds.json was swallowed and fresh credentials
// were minted over it. A studio that WAS paired would appear `never_connected`,
// the owner would be invited to scan a new QR, and the first creds.update after
// that would overwrite the only copy that might still have been recoverable —
// a transient read error silently destroying a working pairing.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';

import { useAtomicFileAuthState } from '../store/authState.js';
import {
  looksLikeCreds,
  quarantineSession,
  sweepQuarantine,
  RecoveryOutcome,
} from '../store/sessionRecovery.js';
import { setLoggerForTesting } from '../logger.js';

let root: string;
let dir: string;
let quarantineDir: string;

beforeEach(async () => {
  setLoggerForTesting(pino({ level: 'silent' }));
  root = await mkdtemp(path.join(tmpdir(), 'wa-gw-rec-'));
  dir = path.join(root, 'sessions', 'a1b2c3d4-0000-4000-8000-000000000001');
  quarantineDir = path.join(root, 'quarantine');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  setLoggerForTesting(undefined);
});

/** A credential set good enough to pass validation. */
function validCreds(registrationId = 42): Record<string, unknown> {
  const key = () => ({ private: { type: 'Buffer', data: [1, 2, 3] }, public: { type: 'Buffer', data: [4, 5, 6] } });
  return { noiseKey: key(), signedIdentityKey: key(), registrationId };
}

describe('looksLikeCreds', () => {
  it('accepts a real credential shape', () => {
    expect(looksLikeCreds(validCreds())).toBe(true);
  });

  it('rejects things that parse as JSON but are not credentials', () => {
    // `JSON.parse` succeeding is not enough — §13.2 says "parses AND has a
    // device identity". A truncated write can land on valid JSON, and handing
    // that to Baileys as a session fails much later and far less legibly.
    const notCreds = [
      null,
      undefined,
      {},
      [],
      'a string',
      42,
      { registrationId: 1 }, // no keys
      { noiseKey: validCreds()['noiseKey'], registrationId: 1 }, // no identity key
      { ...validCreds(), registrationId: 'not-a-number' },
      { noiseKey: { private: null, public: null }, signedIdentityKey: {}, registrationId: 1 },
    ];
    for (const value of notCreds) {
      expect(looksLikeCreds(value), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('credential loading', () => {
  it('reports FRESH for a directory that has never been paired', async () => {
    const auth = await useAtomicFileAuthState(dir, quarantineDir);
    expect(auth.outcome).toBe(RecoveryOutcome.FRESH);
    expect(auth.restored).toBe(false);
    expect(auth.quarantinePath).toBeUndefined();
  });

  it('reports RESTORED for a healthy session', async () => {
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    await first.saveCreds();

    const second = await useAtomicFileAuthState(dir, quarantineDir);
    expect(second.outcome).toBe(RecoveryOutcome.RESTORED);
    expect(second.restored).toBe(true);
  });

  it('recovers from the backup when the primary is truncated', async () => {
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    await first.saveCreds();
    await first.saveCreds(); // creates creds.json.bak
    const registrationId = first.state.creds.registrationId;

    // Simulate filesystem-level damage to the primary only.
    await writeFile(path.join(dir, 'creds.json'), '{"truncated":');

    const recovered = await useAtomicFileAuthState(dir, quarantineDir);
    expect(recovered.outcome).toBe(RecoveryOutcome.RESTORED_FROM_BACKUP);
    expect(recovered.restored).toBe(true);
    expect(recovered.state.creds.registrationId).toBe(registrationId);
    // No quarantine — nothing was lost.
    expect(recovered.quarantinePath).toBeUndefined();
  });

  it('promotes the recovered backup so the next restart is clean', async () => {
    // Leaving the bad file in place would re-run recovery on every restart,
    // and a second corruption would then have no backup left to fall back to.
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    await first.saveCreds();
    await first.saveCreds();
    await writeFile(path.join(dir, 'creds.json'), 'not json at all');

    await useAtomicFileAuthState(dir, quarantineDir);

    const third = await useAtomicFileAuthState(dir, quarantineDir);
    expect(third.outcome).toBe(RecoveryOutcome.RESTORED);
  });

  it('quarantines when BOTH copies are unusable', async () => {
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    await first.saveCreds();
    await first.saveCreds();

    await writeFile(path.join(dir, 'creds.json'), '{"broken":');
    await writeFile(path.join(dir, 'creds.json.bak'), 'also broken');

    const auth = await useAtomicFileAuthState(dir, quarantineDir);
    expect(auth.outcome).toBe(RecoveryOutcome.QUARANTINED);
    expect(auth.restored).toBe(false);
    expect(auth.quarantinePath).toBeDefined();

    // The evidence survives — deleting it would destroy the only artefact that
    // explains what happened.
    const preserved = await readdir(auth.quarantinePath as string);
    expect(preserved).toContain('creds.json');
    expect(preserved).toContain('creds.json.bak');

    // And the session directory is usable again for a fresh pairing.
    expect(await readdir(dir)).toEqual([]);
  });

  it('quarantines a creds file that parses but carries no device identity', async () => {
    // The subtle case: valid JSON, wrong content. Without the shape check this
    // would be handed to Baileys as a session.
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'creds.json'), JSON.stringify({ hello: 'world' }));

    const auth = await useAtomicFileAuthState(dir, quarantineDir);
    expect(auth.outcome).toBe(RecoveryOutcome.QUARANTINED);
  });

  it('does not quarantine a first run', async () => {
    // The regression guard: absent must never be confused with corrupt.
    const auth = await useAtomicFileAuthState(dir, quarantineDir);
    expect(auth.outcome).toBe(RecoveryOutcome.FRESH);
    await expect(readdir(quarantineDir)).rejects.toThrow();
  });
});

describe('quarantineSession', () => {
  it('preserves the directory contents under a timestamped name', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'creds.json'), 'x');
    await writeFile(path.join(dir, 'pre-key-1.json'), 'y');

    const target = await quarantineSession(dir, quarantineDir, 'inst-1');
    expect(target).toBeDefined();
    expect(path.basename(target as string)).toMatch(/^inst-1-\d{4}-\d{2}-\d{2}T/);
    expect((await readdir(target as string)).sort()).toEqual(['creds.json', 'pre-key-1.json']);
    expect(await readdir(dir)).toEqual([]);
  });

  it('is a no-op for an empty or missing directory', async () => {
    expect(await quarantineSession(dir, quarantineDir, 'inst-1')).toBeUndefined();
    await mkdir(dir, { recursive: true });
    expect(await quarantineSession(dir, quarantineDir, 'inst-1')).toBeUndefined();
  });

  it('does not collide when the same instance is quarantined twice', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'creds.json'), 'first');
    const a = await quarantineSession(dir, quarantineDir, 'inst-1');

    await writeFile(path.join(dir, 'creds.json'), 'second');
    const b = await quarantineSession(dir, quarantineDir, 'inst-1');

    expect(a).not.toBe(b);
    expect((await readdir(quarantineDir)).length).toBe(2);
  });
});

describe('sweepQuarantine', () => {
  async function makeQuarantined(name: string, ageDays: number): Promise<string> {
    const target = path.join(quarantineDir, name);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'creds.json'), 'x');
    const when = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await utimes(target, when, when);
    return target;
  }

  it('removes entries past the retention window and keeps the rest', async () => {
    // These hold real (dead) WhatsApp device identities. Keeping them forever
    // is a growing liability for a diminishing diagnostic return.
    await makeQuarantined('old-1', 30);
    await makeQuarantined('old-2', 8);
    await makeQuarantined('recent', 1);

    const result = await sweepQuarantine(quarantineDir, 7);
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);
    expect(await readdir(quarantineDir)).toEqual(['recent']);
  });

  it('returns zero rather than throwing when nothing has been quarantined', async () => {
    // A sweep failure must never stop a boot.
    expect(await sweepQuarantine(path.join(root, 'does-not-exist'), 7)).toEqual({
      removed: 0,
      kept: 0,
    });
  });

  it('keeps everything when the window has not elapsed', async () => {
    await makeQuarantined('recent', 1);
    const result = await sweepQuarantine(quarantineDir, 7);
    expect(result.removed).toBe(0);
    expect(result.kept).toBe(1);
  });
});

describe('the end-to-end persistence property', () => {
  it('a paired session survives a restart without needing a QR', async () => {
    // This is the Definition-of-Done line "Docker restart does not
    // unnecessarily require QR", proven at the storage layer. The real proof is
    // Phase 10 with a phone; this proves the half that can be automated.
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    first.state.creds.registered = true;
    await first.saveCreds();
    await first.state.keys.set({ session: { 'peer-1': new Uint8Array([7, 7, 7]) } });

    // "Restart": a completely new handle over the same directory.
    const second = await useAtomicFileAuthState(dir, quarantineDir);

    expect(second.outcome).toBe(RecoveryOutcome.RESTORED);
    expect(second.state.creds.registered).toBe(true);
    expect(second.state.creds.registrationId).toBe(first.state.creds.registrationId);

    const keys = await second.state.keys.get('session', ['peer-1']);
    expect(Buffer.from(keys['peer-1'] as Uint8Array).equals(Buffer.from([7, 7, 7]))).toBe(true);
  });

  it('a logged-out session does NOT survive — credentials are destroyed', async () => {
    const first = await useAtomicFileAuthState(dir, quarantineDir);
    await first.saveCreds();
    await first.saveCreds();
    await first.clear();

    const second = await useAtomicFileAuthState(dir, quarantineDir);
    // Including the backup: clear() must not leave a copy behind that a later
    // recovery could resurrect a dead session from.
    expect(second.outcome).toBe(RecoveryOutcome.FRESH);
    expect(await readFile(path.join(dir, 'creds.json.bak'), 'utf8').catch(() => null)).toBeNull();
  });
});
