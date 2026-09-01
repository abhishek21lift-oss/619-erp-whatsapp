// Graceful shutdown (architecture §15.2).
//
// ── Why this matters more here than in an ordinary service ──────────────────
//
// Two things are in flight when SIGTERM arrives, and abandoning either has a
// cost that outlives the process:
//
//   • A webhook delivery mid-request. Dropped, the event sits in the
//     processing list until the sweeper reclaims it a minute later — so the
//     ERP's view of a studio's connection is stale for that minute.
//
//   • A WhatsApp socket. Dropped without a clean close, it is a TCP connection
//     that vanishes mid-session, which is one of the traffic patterns that
//     looks like abuse from WhatsApp's side. That is a risk to the studio's
//     phone number, not just to this process.
//
// Everything below is deterministic and needs no Redis and no WhatsApp. The
// process-level SIGTERM check — the one that proves the whole sequence in
// server.ts, in order, under a real signal — is in docs/TESTING.md, because it
// needs a built dist and a live Redis.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pino } from 'pino';

import { Outbox } from '../events/outbox.js';
import { DeliveryWorker } from '../events/deliverer.js';
import { EventType } from '../events/schema.js';
import { NullConnector } from '../domain/nullConnector.js';
import { InstanceState } from '../domain/instance.js';
import { ReconnectScheduler } from '../domain/reconnectScheduler.js';
import { setLoggerForTesting } from '../logger.js';
import { FakeRedis } from './fakeRedis.js';
import { ORG_A } from './helpers.js';

const SECRET = 'a-webhook-secret-long-enough-to-be-real-0123456789';
const INSTANCE = '3b7e0000-0000-4000-8000-000000000002';

beforeEach(() => setLoggerForTesting(pino({ level: 'silent' })));

/** A deliverer whose HTTP call can be held open on demand. */
function build(options: { hold?: () => Promise<void> } = {}) {
  const redis = new FakeRedis();
  const outbox = new Outbox(redis.asRedis());
  let inFlight = 0;
  let completed = 0;

  const worker = new DeliveryWorker({
    outbox,
    backendUrl: 'http://backend.test:5000',
    webhookSecret: SECRET,
    idlePollMs: 5,
    fetchImpl: (async () => {
      inFlight += 1;
      if (options.hold) await options.hold();
      inFlight -= 1;
      completed += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch,
  });

  const enqueue = () =>
    outbox.enqueue(EventType.INSTANCE_CONNECTED, {
      instanceId: INSTANCE,
      tenantId: ORG_A,
      payload: { phone_e164: null, connected_at: '2026-09-01T10:00:00.000Z' },
    });

  return { redis, outbox, worker, enqueue, stats: () => ({ inFlight, completed }) };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('DeliveryWorker shutdown', () => {
  it('waits for the in-flight delivery instead of abandoning it', async () => {
    // The property: stop() must not resolve while a webhook POST is still
    // outstanding. Returning early leaves the event in the processing list
    // until the sweeper reclaims it, which delays a state change the ERP is
    // waiting on by a minute for no reason.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });

    const { worker, enqueue, outbox, stats } = build({ hold: () => held });
    await enqueue();

    worker.start();
    await tick();
    expect(stats().inFlight).toBe(1);

    let stopped = false;
    const stopping = worker.stop().then(() => { stopped = true; });

    await tick();
    expect(stopped, 'stop() must not resolve while a delivery is outstanding').toBe(false);

    release();
    await stopping;

    expect(stopped).toBe(true);
    expect(stats().completed).toBe(1);
    // Acknowledged, so nothing is stranded in `processing` for the sweeper.
    expect(await outbox.depth()).toMatchObject({ pending: 0, processing: 0 });
  });

  it('accounts for every event on shutdown — delivered or still queued', async () => {
    // The property is conservation, not completeness: it does not matter how
    // many of the three got out before the signal, but every one that did not
    // must still be in Redis for the next process to pick up. An event that is
    // neither delivered nor queued is a state change the ERP never learns.
    const { worker, enqueue, outbox, stats } = build();
    const TOTAL = 3;
    for (let i = 0; i < TOTAL; i += 1) await enqueue();

    worker.start();
    await tick();
    await worker.stop();

    const depth = await outbox.depth();
    const stillQueued = depth.pending + depth.processing + depth.retrying;

    expect(stats().completed + stillQueued).toBe(TOTAL);
    expect(depth.dead).toBe(0);
  });

  it('is idempotent — a second SIGTERM must not start a second teardown', async () => {
    const { worker } = build();
    worker.start();
    await tick();

    await expect(Promise.all([worker.stop(), worker.stop()])).resolves.toBeDefined();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('start() twice does not run two loops', async () => {
    // Two loops would claim the same events concurrently and double every
    // delivery — safe, because the backend's ledger absorbs duplicates, but
    // pointless load on a service whose whole risk profile is looking noisy.
    const { worker, enqueue, stats } = build();
    await enqueue();

    worker.start();
    worker.start();
    await tick();
    await worker.stop();

    expect(stats().completed).toBe(1);
  });

  it('stops cleanly when it was never started', async () => {
    const { worker } = build();
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('survives a delivery that throws while shutting down', async () => {
    // stop() must not reject. server.ts awaits it inside the shutdown
    // sequence, and a rejection there would skip closing the WhatsApp sockets
    // — the one step whose omission costs more than this process.
    const redis = new FakeRedis();
    const outbox = new Outbox(redis.asRedis());
    const worker = new DeliveryWorker({
      outbox,
      backendUrl: 'http://backend.test:5000',
      webhookSecret: SECRET,
      idlePollMs: 5,
      fetchImpl: (() => Promise.reject(new Error('socket hang up'))) as unknown as typeof fetch,
    });
    await outbox.enqueue(EventType.INSTANCE_DISCONNECTED, {
      instanceId: INSTANCE,
      tenantId: ORG_A,
      payload: { reason_code: 'timed_out', will_retry: true, next_retry_at: null },
    });

    worker.start();
    await tick();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});

describe('connector shutdown', () => {
  it('releases every instance', async () => {
    const connector = new NullConnector();
    await connector.start('a1b2c3d4-0000-4000-8000-000000000001');
    await connector.start('a1b2c3d4-0000-4000-8000-000000000002');

    await connector.shutdown();

    // Back to the state a fresh process would report, so nothing lingers to be
    // confused with a live socket.
    expect(connector.stateOf('a1b2c3d4-0000-4000-8000-000000000001')).toBe(
      InstanceState.NEVER_CONNECTED,
    );
  });

  it('is safe to call twice', async () => {
    const connector = new NullConnector();
    await connector.shutdown();
    await expect(connector.shutdown()).resolves.toBeUndefined();
  });
});

describe('pending reconnects do not outlive shutdown', () => {
  it('an armed backoff timer is cancelled, not left to fire', () => {
    // A timer firing after teardown opens a WhatsApp socket behind a process
    // that is closing, and nothing is left to close it.
    const onRetry = vi.fn();
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000, maxMs: 10_000, maxAttempts: 5, onRetry,
    });

    scheduler.schedule();
    expect(scheduler.pending).toBe(true);

    scheduler.cancel();

    expect(scheduler.pending).toBe(false);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('unrefs its timer so a pending retry cannot hold the process open', () => {
    // Without this, `docker compose stop` waits out the full backoff — up to
    // five minutes — before the container exits, and Docker escalates to
    // SIGKILL partway through the teardown this file exists to protect.
    const unref = vi.fn();
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      maxMs: 10_000,
      maxAttempts: 5,
      onRetry: () => undefined,
      setTimer: () => ({ unref }) as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
    });

    scheduler.schedule();
    expect(unref).toHaveBeenCalledOnce();
  });
});
