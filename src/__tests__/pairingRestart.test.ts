// The pairing lifecycle, driven through a fake Baileys socket.
//
// ── The bug these exist to keep fixed ───────────────────────────────────────
//
// WhatsApp closes an unscanned pairing socket with 428 after about four QR
// rounds. classifyDisconnect() sees only the status code, so it calls that
// 'retry' — right for a paired instance whose link is flapping, and wrong for
// a pairing session, where it fed every expired QR into the exponential
// backoff loop.
//
// The gap between one code disappearing and the next appearing therefore grew
// on every round: 0.5s, 3s, 6s, … up to WA_RECONNECT_MAX_MS (five minutes).
// Production caught it mid-climb — `attempt: 10, delay_ms: 86680`, an
// 87-second window with no QR in Redis at all — and then
// `reconnect_attempts_exhausted`, after which no code was offered ever again.
// The studio saw a dialog stuck on "Waiting for a code…".
//
// Nothing caught it because BaileysConnector had no lifecycle test of any
// kind: the whole class was covered only by extractPhoneE164's unit test, and
// its three extracted helpers (disconnect/backoff/reconnectScheduler) are each
// correct in isolation. The defect was in how the connector CHOSE between
// them, which is reachable only by driving a socket — so here is one.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';

// ── The fake socket ─────────────────────────────────────────────────────────
//
// Hoisted, because vi.mock's factory is lifted above the imports and may not
// close over anything declared with const below it.
const h = vi.hoisted(() => {
  interface FakeSocket {
    ev: { on: (event: string, cb: (arg: unknown) => void) => void };
    end: (err: unknown) => Promise<void>;
    user: undefined;
    emit: (update: Record<string, unknown>) => Promise<void>;
  }
  const sockets: FakeSocket[] = [];

  function makeWASocket(): FakeSocket {
    const handlers = new Map<string, (arg: unknown) => void>();
    const sock: FakeSocket = {
      ev: { on: (event, cb) => { handlers.set(event, cb); } },
      end: async () => { /* a real end() fires close; the connector guards that */ },
      user: undefined,
      // Dispatches one connection.update. It does NOT wait for whatever the
      // connector kicks off — see waitForSockets/settle below for why counting
      // microtask ticks here was not good enough.
      emit: async (update) => {
        handlers.get('connection.update')?.(update);
        await Promise.resolve();
      },
    };
    sockets.push(sock);
    return sock;
  }

  return { sockets, makeWASocket };
});

vi.mock('baileys', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('baileys');
  return {
    ...actual,
    default: h.makeWASocket,
    makeWASocket: h.makeWASocket,
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 1], isLatest: true }),
    Browsers: { ubuntu: (name: string) => ['Ubuntu', name, '22.04.4'] },
  };
});

const { BaileysConnector } = await import('../domain/baileysConnector.js');
const { InstanceState } = await import('../domain/instance.js');
const { setLoggerForTesting } = await import('../logger.js');

const INSTANCE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG = '11111111-1111-4111-8111-111111111111';

/** WhatsApp's "connection closed" — what an unscanned pairing socket gets. */
const CLOSE_428 = {
  connection: 'close',
  lastDisconnect: { error: { output: { statusCode: 428 } } },
};

let root: string;
let qrWrites: string[];
let events: string[];

/**
 * Wait until `count` sockets exist, or fail.
 *
 * Polling a condition rather than awaiting a fixed number of microtask ticks.
 * The first draft did the latter and passed in isolation, then failed in the
 * full suite at 5 sockets instead of 6: reopening runs through #startInner,
 * which does real filesystem work for the auth state, and under a loaded test
 * runner that takes longer than two ticks. A test whose result depends on how
 * many awaits the implementation happens to contain is a test that will flake
 * on CI and be quietly retried until it passes.
 */
async function waitForSockets(count: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (h.sockets.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} sockets, saw ${h.sockets.length} after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Give any pending async work a real chance to run, then stop.
 *
 * For the NEGATIVE assertions — "no socket was opened", "no event was sent" —
 * where there is no condition to poll for and the whole point is that nothing
 * arrives. Long enough to catch a reopen that genuinely happened.
 */
async function settle(ms = 100): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function build(overrides: Record<string, number> = {}) {
  qrWrites = [];
  events = [];

  return new BaileysConnector({
    sessionRoot: path.join(root, 'sessions'),
    quarantineRoot: path.join(root, 'quarantine'),
    qr: {
      set: async (_id: string, qr: string) => { qrWrites.push(qr); },
      clear: async () => { /* nothing asserts on clears */ },
    },
    outbox: {
      enqueue: async (type: string) => { events.push(type); return undefined as never; },
    } as never,
    resolveTenant: () => ORG,
    qrTtlSec: 60,
    qrMaxRounds: 5,
    pairingMaxRounds: 4,
    connectTimeoutMs: 45_000,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 300_000,
    reconnectMaxAttempts: 10,
    ...overrides,
  } as never);
}

beforeEach(async () => {
  setLoggerForTesting(pino({ level: 'silent' }));
  root = await mkdtemp(path.join(tmpdir(), 'pairing-'));
  h.sockets.length = 0;
});

afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

describe('an unscanned QR expiring is not a connection failure', () => {
  it('reopens immediately for a fresh code instead of arming backoff', async () => {
    // The heart of it. Under the old behaviour this 428 armed a backoff timer
    // and opened NO new socket, so the studio was shown nothing at all until
    // that timer fired — a wait that grew to minutes as attempts accumulated.
    const connector = build();
    await connector.start(INSTANCE);

    await h.sockets[0].emit({ qr: 'code-round-1' });
    expect(qrWrites).toEqual(['code-round-1']);

    await h.sockets[0].emit(CLOSE_428);

    // A second socket appears without any timer having to fire. Under the old
    // behaviour this never arrived — the reopen waited on the backoff clock.
    await waitForSockets(2);

    await h.sockets[1].emit({ qr: 'code-round-2' });
    await settle(20);
    expect(qrWrites).toEqual(['code-round-1', 'code-round-2']);
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.CONNECTING);
  });

  it('does not report the studio as disconnected mid-pairing', async () => {
    // The card behind the dialog would otherwise flicker connecting →
    // disconnected → connecting every minute, and last_error_code would be
    // written on a pairing that is proceeding normally.
    const connector = build();
    await connector.start(INSTANCE);
    await h.sockets[0].emit({ qr: 'code' });
    await h.sockets[0].emit(CLOSE_428);
    await settle();

    expect(events).not.toContain('whatsapp.instance.disconnected');
  });

  it('keeps offering codes across several expiries', async () => {
    // Four rounds at a 60s TTL is roughly four minutes of pairing — the studio
    // has to survive more than one WhatsApp 428 to get that far.
    const connector = build({ pairingMaxRounds: 10 });
    await connector.start(INSTANCE);

    for (let round = 1; round <= 5; round += 1) {
      await waitForSockets(round);
      const sock = h.sockets[round - 1];
      await sock.emit({ qr: `code-${round}` });
      await settle(20);
      await sock.emit(CLOSE_428);
    }

    expect(qrWrites).toEqual(['code-1', 'code-2', 'code-3', 'code-4', 'code-5']);
    // One socket per round plus the one now waiting for round six. Asserted
    // because the codes alone would also be recorded if nothing reopened and
    // the test simply kept talking to the dead socket — which is what the old
    // behaviour did, and is the failure mode this whole file is about.
    await waitForSockets(6);
  });
});

describe('the pairing budget still bounds it', () => {
  it('stops at pairingMaxRounds rather than offering codes forever', async () => {
    // The restart resets the per-socket counter, so without a budget that
    // survives it this loop would never end — and hammering WhatsApp is how a
    // number gets flagged. pairingMaxRounds is 4 in this harness.
    const connector = build({ pairingMaxRounds: 4 });
    await connector.start(INSTANCE);

    for (let round = 1; round <= 8; round += 1) {
      const sock = h.sockets[h.sockets.length - 1];
      await sock.emit({ qr: `code-${round}` });
      await settle(20);
      await sock.emit(CLOSE_428);
      await settle(20);
    }

    expect(qrWrites).toHaveLength(4);
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.QR_TIMEOUT);
  });

  it('tells the ERP the truth when it gives up', async () => {
    const connector = build({ pairingMaxRounds: 1 });
    await connector.start(INSTANCE);
    await h.sockets[0].emit({ qr: 'only-code' });
    await settle(20);
    await h.sockets[0].emit(CLOSE_428);
    await settle();

    expect(events).toContain('whatsapp.instance.disconnected');
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.QR_TIMEOUT);
  });

  it('gives a fresh budget when an operator asks to pair again', async () => {
    // Otherwise qr_timeout is permanent and the Connect button is a lie —
    // which is precisely the dead end the backend's /connect fix exists to
    // escape, so the two halves have to agree.
    const connector = build({ pairingMaxRounds: 1 });
    await connector.start(INSTANCE);
    await h.sockets[0].emit({ qr: 'first' });
    await settle(20);
    await h.sockets[0].emit(CLOSE_428);
    await settle();
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.QR_TIMEOUT);

    await connector.start(INSTANCE);
    const sock = h.sockets[h.sockets.length - 1];
    await sock.emit({ qr: 'second' });
    await settle(20);

    expect(qrWrites).toEqual(['first', 'second']);
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.CONNECTING);
  });
});

describe('a connection that really did fail still backs off', () => {
  it('does not fast-restart an instance that had connected', async () => {
    // The ban-risk case backoff exists for. A paired instance whose link drops
    // must NOT be reopened in a tight loop.
    const connector = build();
    await connector.start(INSTANCE);
    await h.sockets[0].emit({ qr: 'code' });
    await settle(20);
    await h.sockets[0].emit({ connection: 'open' });
    await settle(20);
    expect(connector.stateOf(INSTANCE)).toBe(InstanceState.CONNECTED);

    const socketsBefore = h.sockets.length;
    await h.sockets[0].emit(CLOSE_428);
    await settle();

    // Backoff armed instead: no new socket, even given time to appear.
    expect(h.sockets).toHaveLength(socketsBefore);
    expect(events).toContain('whatsapp.instance.disconnected');
  });

  it('does not fast-restart a credentialed instance that never showed a QR', async () => {
    // A previously-paired instance restored after a gateway restart also has a
    // null connectedAt, which is why "was a QR offered on this socket" is the
    // test rather than "has it ever connected". A 428 on THIS is flapping.
    const connector = build();
    await connector.start(INSTANCE);

    const socketsBefore = h.sockets.length;
    await h.sockets[0].emit(CLOSE_428);
    await settle();

    expect(h.sockets).toHaveLength(socketsBefore);
    expect(events).toContain('whatsapp.instance.disconnected');
  });
});
