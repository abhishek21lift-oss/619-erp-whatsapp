// The Baileys auth state store (architecture §4.2).
//
// These cover the three things our implementation does that Baileys'
// `useMultiFileAuthState` does not — atomic writes, a bounded serializer, and a
// filename that cannot traverse — plus the round-trip that has to keep working
// for a restart to avoid a QR rescan.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { useAtomicFileAuthState, safeFileName } from '../store/authState.js';
import { GatewayError } from '../errors.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'wa-gw-auth-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('safeFileName', () => {
  it('matches Baileys own substitutions so existing sessions stay readable', () => {
    // Compatibility is deliberate: it is the difference between swapping the
    // implementation and forcing every studio to re-scan a QR.
    expect(safeFileName('session-123:4@s.whatsapp.net.json')).toBe(
      'session-123-4@s.whatsapp.net.json',
    );
    expect(safeFileName('sender-key-a/b.json')).toBe('sender-key-a__b.json');
  });

  it('refuses anything that could escape the session directory', () => {
    // Signal ids embed remote JIDs, and a peer chooses its own identifier —
    // so these are attacker-influenced, not merely internal.
    for (const hostile of ['..', '.', '../../etc/passwd', '..\\windows', '\0evil', '']) {
      expect(() => safeFileName(hostile), JSON.stringify(hostile)).toThrowError(GatewayError);
    }
  });

  it('refuses rather than silently rewriting', () => {
    // A silently-rewritten key id would be written to one path and read back
    // from another, presenting as a session that pairs and then fails to
    // decrypt — far harder to diagnose than an outright error.
    expect(() => safeFileName('..')).toThrowError(/unsafe/i);
  });

  it('bounds the length without colliding', () => {
    const a = safeFileName(`sender-key-${'x'.repeat(400)}-A.json`);
    const b = safeFileName(`sender-key-${'x'.repeat(400)}-B.json`);
    expect(a.length).toBeLessThanOrEqual(180);
    expect(b.length).toBeLessThanOrEqual(180);
    // Truncation alone would map these to the same file and corrupt both.
    expect(a).not.toBe(b);
  });
});

describe('useAtomicFileAuthState', () => {
  it('mints fresh credentials on a first run and reports restored: false', async () => {
    const auth = await useAtomicFileAuthState(dir);
    expect(auth.restored).toBe(false);
    expect(auth.state.creds.registrationId).toBeTypeOf('number');
    expect(auth.state.creds.registered).toBe(false);
  });

  it('round-trips credentials across a reopen — the no-rescan property', async () => {
    const first = await useAtomicFileAuthState(dir);
    const registrationId = first.state.creds.registrationId;
    await first.saveCreds();

    const second = await useAtomicFileAuthState(dir);
    expect(second.restored).toBe(true);
    expect(second.state.creds.registrationId).toBe(registrationId);
  });

  it('preserves binary key material through the JSON round-trip', async () => {
    // Signal keys are Uint8Array. A serialiser that turned them into
    // `{"0":12,"1":88,…}` would restore a session that connects and then fails
    // every decryption — which is why BufferJSON is used rather than plain
    // JSON.stringify.
    const first = await useAtomicFileAuthState(dir);
    const original = Buffer.from(first.state.creds.noiseKey.private);
    await first.saveCreds();

    const second = await useAtomicFileAuthState(dir);
    const restored = second.state.creds.noiseKey.private;

    expect(Buffer.isBuffer(restored) || restored instanceof Uint8Array).toBe(true);
    expect(Buffer.from(restored).equals(original)).toBe(true);
  });

  it('stores and reads back signal keys', async () => {
    const auth = await useAtomicFileAuthState(dir);
    const value = new Uint8Array([1, 2, 3, 4, 5]);

    await auth.state.keys.set({ session: { 'peer-1': value } });
    const got = await auth.state.keys.get('session', ['peer-1']);

    expect(Buffer.from(got['peer-1'] as Uint8Array).equals(Buffer.from(value))).toBe(true);
  });

  it('deletes a key when set to null, as Baileys expects', async () => {
    const auth = await useAtomicFileAuthState(dir);
    await auth.state.keys.set({ session: { 'peer-1': new Uint8Array([9]) } });
    await auth.state.keys.set({ session: { 'peer-1': null } });

    const got = await auth.state.keys.get('session', ['peer-1']);
    expect(got['peer-1']).toBeUndefined();
  });

  it('leaves no temp files behind — a torn write is the unrecoverable failure', async () => {
    const auth = await useAtomicFileAuthState(dir);
    await auth.saveCreds();
    await auth.state.keys.set({
      'pre-key': Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [
          String(i),
          { public: new Uint8Array([i]), private: new Uint8Array([i, i]) },
        ]),
      ),
    });

    const files = await readdir(dir);
    expect(files.filter((f) => f.includes('.tmp'))).toHaveLength(0);
    expect(files).toContain('creds.json');
  });

  it('does not interleave concurrent writes', async () => {
    const auth = await useAtomicFileAuthState(dir);

    // Twenty concurrent saves. Without serialisation two writers can rename
    // over each other mid-flight and leave a file that is neither version.
    await Promise.all(Array.from({ length: 20 }, () => auth.saveCreds()));

    const raw = await readFile(path.join(dir, 'creds.json'), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('reports restored: false when creds.json exists but is corrupt', async () => {
    // The distinction that matters for Phase 4: a MISSING file is a first
    // pairing, a CORRUPT one is a session to quarantine. Collapsing them would
    // silently discard a studio's credentials as if they had never connected.
    await writeFile(path.join(dir, 'creds.json'), '{"truncated":');

    const auth = await useAtomicFileAuthState(dir);
    expect(auth.restored).toBe(false);
    expect(auth.state.creds.registrationId).toBeTypeOf('number');
  });

  it('clear() destroys every file but keeps the directory', async () => {
    const auth = await useAtomicFileAuthState(dir);
    await auth.saveCreds();
    await auth.state.keys.set({ session: { 'peer-1': new Uint8Array([1]) } });
    expect((await readdir(dir)).length).toBeGreaterThan(0);

    await auth.clear();

    // Empty, but still present — so a re-pair can write straight into it
    // without racing an mkdir.
    expect(await readdir(dir)).toEqual([]);
  });

  it('treats an unknown key id as absent rather than throwing', async () => {
    const auth = await useAtomicFileAuthState(dir);
    const got = await auth.state.keys.get('pre-key', ['never-written']);
    expect(got['never-written']).toBeUndefined();
  });
});
