// Refusing to send to a number nobody has on WhatsApp.
//
// ── The production failure ──────────────────────────────────────────────────
//
// `sock.sendMessage` does not fail for a JID that belongs to nobody. It
// resolves with a message key, exactly like a real send, so the ERP recorded
// 'sent', stored the provider id, and showed the studio a row that looked
// delivered. Every client mobile in that database was stored as ten bare
// digits with no country code, so every JID was for nobody: eight messages
// over eight days, zero delivery receipts, and nothing anywhere that said so.
//
// The backend now resolves numbers to E.164 before they reach the gateway,
// which removes that cause. This is the other half — the check that catches
// the CLASS, including the version of it with no code change behind it: one
// client's number typed wrong.
//
// ── Why this file exists rather than an assertion in an existing one ────────
//
// None of the other suites can reach it. outboundMessages.test.ts drives
// registry.sendMessage through FakeConnector, which never runs the real
// connector's send path at all, and pairingRestart.test.ts's fake socket has
// no sendMessage on it. Getting at #assertOnWhatsApp means a fake socket that
// can be driven to CONNECTED and then sent through, which is what this builds.
//
// The trap this file is deliberately built around: the check fails OPEN when
// the lookup cannot answer, so a fake socket that simply lacks `onWhatsApp`
// would make every send succeed and every test here pass while testing
// nothing. `onWhatsApp` is therefore explicit on the fake, records its calls,
// and its absence is itself a case below.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pino } from 'pino';

const h = vi.hoisted(() => {
  interface FakeSocket {
    ev: { on: (event: string, cb: (arg: unknown) => void) => void };
    end: (err: unknown) => Promise<void>;
    user: { id: string } | undefined;
    emit: (update: Record<string, unknown>) => Promise<void>;
    sendMessage: (jid: string, content: unknown) => Promise<{ key: { id: string } }>;
    onWhatsApp?: (...jids: string[]) => Promise<{ jid: string; exists: boolean }[] | undefined>;
    sent: string[];
    looked: string[];
    ended: boolean;
  }
  const sockets: FakeSocket[] = [];
  /** Swapped per test: what the USync lookup answers, or how it fails. */
  let lookup: (jid: string) => Promise<{ jid: string; exists: boolean }[] | undefined> =
    async (jid) => [{ jid, exists: true }];
  let lookupEnabled = true;

  function makeWASocket(): FakeSocket {
    const handlers = new Map<string, (arg: unknown) => void>();
    const sock: FakeSocket = {
      ev: { on: (event, cb) => { handlers.set(event, cb); } },
      end: async () => { sock.ended = true; },
      user: { id: '918858982354:1@s.whatsapp.net' },
      ended: false,
      sent: [],
      looked: [],
      sendMessage: async (jid) => {
        sock.sent.push(jid);
        return { key: { id: 'WAMSG1' } };
      },
      emit: async (update) => {
        handlers.get('connection.update')?.(update);
        await Promise.resolve();
      },
    };
    if (lookupEnabled) {
      sock.onWhatsApp = async (...jids) => {
        const jid = jids[0] ?? '';
        sock.looked.push(jid);
        return lookup(jid);
      };
    }
    sockets.push(sock);
    return sock;
  }

  return {
    sockets,
    makeWASocket,
    setLookup: (fn: typeof lookup) => { lookup = fn; },
    setLookupEnabled: (on: boolean) => { lookupEnabled = on; },
  };
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
const { AlwaysAcquiredInstanceLock } = await import('../store/instanceLock.js');
const { GatewayError, ErrorCode } = await import('../errors.js');

const INSTANCE = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG = '11111111-1111-4111-8111-111111111111';

let root: string;

function build() {
  return new BaileysConnector({
    sessionRoot: path.join(root, 'sessions'),
    quarantineRoot: path.join(root, 'quarantine'),
    qr: { set: async () => {}, clear: async () => {} },
    outbox: { enqueue: async () => undefined as never },
    resolveTenant: () => ORG,
    lock: new AlwaysAcquiredInstanceLock(),
    qrTtlSec: 60,
    qrMaxRounds: 5,
    pairingMaxRounds: 4,
    connectTimeoutMs: 45_000,
    reconnectBaseMs: 2_000,
    reconnectMaxMs: 300_000,
    reconnectMaxAttempts: 10,
  } as never);
}

function socket(index: number) {
  const sock = h.sockets.at(index);
  if (!sock) throw new Error(`expected a socket at index ${index}, saw ${h.sockets.length}`);
  return sock;
}

/** A connector with one instance driven all the way to CONNECTED. */
async function connected() {
  const connector = build();
  await connector.start(INSTANCE);
  await socket(0).emit({ connection: 'open' });
  expect(connector.stateOf(INSTANCE)).toBe(InstanceState.CONNECTED);
  return connector;
}

beforeEach(async () => {
  setLoggerForTesting(pino({ level: 'silent' }));
  root = await mkdtemp(path.join(tmpdir(), 'recipient-'));
  h.sockets.length = 0;
  h.setLookupEnabled(true);
  h.setLookup(async (jid) => [{ jid, exists: true }]);
});

afterEach(async () => {
  // Retried, not plain. Every test shuts its connector down first, but the
  // atomic auth-state writer can still be flushing a file into this directory
  // as the tree is removed, and the resulting ENOTEMPTY failed the test that
  // happened to be last rather than the one that was slow. ENOTEMPTY is in the
  // set node's rm retries.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 });
});

describe('a registered number sends normally', () => {
  it('checks first, then sends to the same JID', async () => {
    const connector = await connected();

    const out = await connector.sendText(INSTANCE, '+919876543210', 'hi');

    expect(out).toEqual({ provider_message_id: 'WAMSG1' });
    expect(socket(0).looked).toEqual(['919876543210@s.whatsapp.net']);
    expect(socket(0).sent).toEqual(['919876543210@s.whatsapp.net']);
    await connector.shutdown();
  });
});

describe('an unregistered number is refused', () => {
  // Baileys reports absence by OMISSION — its result list is filtered to the
  // contacts that exist — so this is the shape a real unregistered number
  // comes back as, not `exists: false`.
  it('throws RECIPIENT_NOT_ON_WHATSAPP and never calls sendMessage', async () => {
    h.setLookup(async () => []);
    const connector = await connected();

    await expect(connector.sendText(INSTANCE, '+919876543210', 'hi')).rejects.toMatchObject({
      code: ErrorCode.RECIPIENT_NOT_ON_WHATSAPP,
    });

    // The assertion that matters. Before the check, this send resolved with a
    // message id and the ERP recorded it as delivered-looking.
    expect(socket(0).sent).toEqual([]);
    await connector.shutdown();
  });

  it('is a GatewayError, so the ERP branches on a code and not on text', async () => {
    h.setLookup(async () => []);
    const connector = await connected();

    const err = await connector.sendText(INSTANCE, '+919876543210', 'hi').catch((e) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect(err.statusCode).toBe(422);
    // A client's phone number is their personal contact detail. It must not
    // travel in an error that ends up in a log file.
    expect(JSON.stringify({ message: err.message, context: err.context }))
      .not.toContain('9876543210');
    await connector.shutdown();
  });

  it('an explicit exists: false is refused too', async () => {
    h.setLookup(async (jid) => [{ jid, exists: false }]);
    const connector = await connected();

    await expect(connector.sendText(INSTANCE, '+919876543210', 'hi')).rejects.toBeInstanceOf(GatewayError);
    expect(socket(0).sent).toEqual([]);
    await connector.shutdown();
  });
});

describe('the check fails open when it cannot answer', () => {
  // A USync query runs over the live socket and can fail for reasons that have
  // nothing to do with the number. Stopping a studio's messages during a blip
  // is a worse failure than the one the check prevents.
  it('sends when the lookup throws', async () => {
    h.setLookup(async () => { throw new Error('usync timed out'); });
    const connector = await connected();

    await expect(connector.sendText(INSTANCE, '+919876543210', 'hi'))
      .resolves.toEqual({ provider_message_id: 'WAMSG1' });
    expect(socket(0).sent).toEqual(['919876543210@s.whatsapp.net']);
    await connector.shutdown();
  });

  it('sends when the lookup returns no answer at all', async () => {
    h.setLookup(async () => undefined);
    const connector = await connected();

    await expect(connector.sendText(INSTANCE, '+919876543210', 'hi'))
      .resolves.toEqual({ provider_message_id: 'WAMSG1' });
    await connector.shutdown();
  });

  it('sends against a Baileys build that has no onWhatsApp', async () => {
    // Pinned deliberately: this is the shape that would make every OTHER test
    // in this file pass while checking nothing, so it is worth one test that
    // says the fail-open is intended rather than accidental.
    h.setLookupEnabled(false);
    const connector = await connected();

    await expect(connector.sendText(INSTANCE, '+919876543210', 'hi'))
      .resolves.toEqual({ provider_message_id: 'WAMSG1' });
    await connector.shutdown();
  });
});
