// The outbox delivery worker (architecture §8.4).
//
// Delivery is where "at-least-once" is either true or a claim. Every case here
// is one where losing the event silently would leave the ERP's
// whatsapp_instances row permanently disagreeing with reality — a studio shown
// as Connected that is not, or the reverse.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { pino } from 'pino';

import { Outbox } from '../events/outbox.js';
import { DeliveryWorker, WEBHOOK_PATH } from '../events/deliverer.js';
import { EventType } from '../events/schema.js';
import { verifySignature, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from '../events/signing.js';
import { keys } from '../store/redis.js';
import { setLoggerForTesting } from '../logger.js';
import { FakeRedis } from './fakeRedis.js';
import { ORG_A } from './helpers.js';

const SECRET = 'a-webhook-secret-long-enough-to-be-real-0123456789';
const INSTANCE = '3b7e0000-0000-4000-8000-000000000002';

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(options: {
  respond?: (call: number) => Response | Promise<Response>;
  maxAttempts?: number;
  now?: () => number;
} = {}) {
  setLoggerForTesting(pino({ level: 'silent' }));

  const redis = new FakeRedis();
  const outbox = new Outbox(redis.asRedis());
  const calls: Captured[] = [];

  const fetchImpl = vi.fn(async (url: unknown, init: unknown) => {
    const request = init as { headers: Record<string, string>; body: string };
    calls.push({ url: String(url), headers: request.headers, body: request.body });
    const responder = options.respond ?? (() => new Response('{}', { status: 200 }));
    return responder(calls.length);
  }) as unknown as typeof fetch;

  const worker = new DeliveryWorker({
    outbox,
    backendUrl: 'http://backend.test:5000',
    webhookSecret: SECRET,
    fetchImpl,
    retryBaseMs: 1_000,
    retryMaxMs: 8_000,
    ...(options.maxAttempts !== undefined ? { maxAttempts: options.maxAttempts } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  return { redis, outbox, worker, calls };
}

const enqueueConnected = (outbox: Outbox) =>
  outbox.enqueue(EventType.INSTANCE_CONNECTED, {
    instanceId: INSTANCE,
    tenantId: ORG_A,
    payload: { phone_e164: '+919876543210', connected_at: '2026-09-01T10:00:00.000Z' },
  });

beforeEach(() => setLoggerForTesting(pino({ level: 'silent' })));

describe('successful delivery', () => {
  it('posts to the backend webhook path and acknowledges', async () => {
    const { outbox, worker, calls } = setup();
    await enqueueConnected(outbox);

    const result = await worker.tick();

    expect(result.didWork).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`http://backend.test:5000${WEBHOOK_PATH}`);
    expect(await outbox.depth()).toEqual({ pending: 0, processing: 0, retrying: 0, dead: 0 });
  });

  it('signs the request so the backend can verify it', async () => {
    // The round trip that matters: what the worker actually sends must pass the
    // verifier the backend will implement. Testing signing and delivery
    // separately would let the two drift.
    const { outbox, worker, calls } = setup();
    await enqueueConnected(outbox);
    await worker.tick();

    const sent = calls[0]!;
    expect(
      verifySignature({
        rawBody: sent.body,
        signature: sent.headers[SIGNATURE_HEADER],
        timestamp: sent.headers[TIMESTAMP_HEADER],
        secret: SECRET,
      }),
    ).toEqual({ ok: true });
  });

  it('sends the event id as a header as well as in the body', async () => {
    const { outbox, worker, calls } = setup();
    const event = await enqueueConnected(outbox);
    await worker.tick();

    expect(calls[0]!.headers[EVENT_ID_HEADER]).toBe(event.event_id);
    expect(JSON.parse(calls[0]!.body).event_id).toBe(event.event_id);
  });

  it('sends the envelope, not the storage wrapper', async () => {
    // The ERP's contract is the event envelope from Appendix B. `attempts` and
    // `enqueued_at` are this service's bookkeeping and must not leak into it.
    const { outbox, worker, calls } = setup();
    await enqueueConnected(outbox);
    await worker.tick();

    const body = JSON.parse(calls[0]!.body);
    expect(Object.keys(body).sort()).toEqual([
      'event_id',
      'event_type',
      'instance_id',
      'occurred_at',
      'payload',
      'schema_version',
      'tenant_id',
    ]);
  });

  it('drains several events across successive ticks, oldest first', async () => {
    const { outbox, worker, calls } = setup();
    const first = await enqueueConnected(outbox);
    const second = await outbox.enqueue(EventType.INSTANCE_DISCONNECTED, {
      instanceId: INSTANCE,
      tenantId: ORG_A,
      payload: { reason_code: 'timed_out', will_retry: true, next_retry_at: null },
    });

    await worker.tick();
    await worker.tick();
    expect((await worker.tick()).didWork).toBe(false);

    expect(calls.map((c) => JSON.parse(c.body).event_id)).toEqual([
      first.event_id,
      second.event_id,
    ]);
  });
});

describe('failed delivery', () => {
  it('schedules a retry on a 5xx rather than losing the event', async () => {
    const now = 1_000_000;
    const { outbox, worker, redis } = setup({
      respond: () => new Response('boom', { status: 500 }),
      now: () => now,
    });
    await enqueueConnected(outbox);

    await worker.tick();

    const depth = await outbox.depth();
    expect(depth).toEqual({ pending: 0, processing: 0, retrying: 1, dead: 0 });

    // Scheduled in the future, and the attempt counter persisted with it — so
    // a gateway restart does not hand the event a fresh budget.
    const entry = redis.zsets.get(keys.outboxRetry)![0]!;
    expect(entry.score).toBeGreaterThan(now);
    expect(JSON.parse(entry.member).attempts).toBe(1);
  });

  it('schedules a retry when the request throws', async () => {
    const { outbox, worker } = setup({
      respond: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await enqueueConnected(outbox);

    await worker.tick();

    expect((await outbox.depth()).retrying).toBe(1);
  });

  it('retries a 401 too, because that means the secrets have drifted', async () => {
    // The one 4xx the backend is expected to return, and it is a deploy error
    // that WILL be fixed. Dropping the event on it would silently lose state
    // changes for as long as the mismatch lasted.
    const { outbox, worker } = setup({ respond: () => new Response('', { status: 401 }) });
    await enqueueConnected(outbox);

    await worker.tick();

    expect((await outbox.depth()).retrying).toBe(1);
  });

  it('redelivers once the retry comes due, and succeeds', async () => {
    let clock = 1_000_000;
    const { outbox, worker, calls } = setup({
      respond: (call) => new Response('', { status: call === 1 ? 503 : 200 }),
      now: () => clock,
    });
    await enqueueConnected(outbox);

    await worker.tick();
    expect((await outbox.depth()).retrying).toBe(1);

    // Not yet due — nothing should move.
    expect((await worker.tick()).didWork).toBe(false);
    expect(calls).toHaveLength(1);

    clock += 60_000;
    await worker.tick();

    expect(calls).toHaveLength(2);
    expect(await outbox.depth()).toEqual({ pending: 0, processing: 0, retrying: 0, dead: 0 });
  });

  it('dead-letters after the attempt budget is spent, preserving the event', async () => {
    let clock = 1_000_000;
    const { outbox, worker, redis } = setup({
      respond: () => new Response('', { status: 500 }),
      maxAttempts: 3,
      now: () => clock,
    });
    await enqueueConnected(outbox);

    for (let i = 0; i < 3; i += 1) {
      await worker.tick();
      clock += 120_000;
    }

    const depth = await outbox.depth();
    expect(depth.dead).toBe(1);
    expect(depth.retrying).toBe(0);
    expect(depth.processing).toBe(0);

    // Preserved, not dropped: a dead-lettered event is a state change the ERP
    // never received, so somebody has to be able to see what it was.
    const dead = JSON.parse(redis.lists.get(keys.outboxDead)![0]!);
    expect(dead.attempts).toBe(3);
    expect(dead.event.event_type).toBe(EventType.INSTANCE_CONNECTED);
  });

  it('backs off further on each successive attempt', async () => {
    let clock = 1_000_000;
    const { outbox, worker, redis } = setup({
      respond: () => new Response('', { status: 500 }),
      maxAttempts: 5,
      now: () => clock,
    });
    await enqueueConnected(outbox);

    const ceilings: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      await worker.tick();
      const entry = redis.zsets.get(keys.outboxRetry)?.[0];
      if (entry) ceilings.push(entry.score - clock);
      clock += 600_000;
    }

    // Jitter means individual delays are not monotonic, but the reachable
    // maximum must grow — otherwise the backoff is not backing off.
    expect(Math.max(...ceilings.slice(2))).toBeGreaterThan(Math.min(...ceilings.slice(0, 2)));
  });
});

describe('robustness', () => {
  it('dead-letters an unparseable envelope instead of wedging the queue', async () => {
    // One poisoned entry must not stop every later event from being delivered.
    const { outbox, redis, worker, calls } = setup();
    await redis.lpush(keys.outbox, 'this is not json');
    await enqueueConnected(outbox);

    await worker.tick(); // consumes the poison
    await worker.tick(); // delivers the real event

    expect(calls).toHaveLength(1);
    expect((await outbox.depth()).dead).toBe(1);
  });

  it('leaves the event reclaimable when Redis fails while recording the outcome', async () => {
    // The nastiest ordering: delivery succeeded but the acknowledgement did
    // not. The event stays in `processing`, which is exactly what reclaimStale
    // exists for — so it is redelivered rather than lost. A duplicate is safe;
    // the backend's ledger absorbs it.
    const { outbox, redis, worker } = setup();
    await enqueueConnected(outbox);

    redis.failNextWrite = true;
    await expect(worker.tick()).resolves.toEqual({ didWork: true });

    expect((await outbox.depth()).processing).toBe(1);
    expect(await outbox.reclaimStale(Date.now() + 120_000)).toBe(1);
    expect((await outbox.depth()).pending).toBe(1);
  });

  it('reports no work rather than throwing when Redis is unavailable', async () => {
    const { worker, redis } = setup();
    redis.zrangebyscore = () => Promise.reject(new Error('connection lost'));

    await expect(worker.tick()).resolves.toEqual({ didWork: false });
  });

  it('never posts anywhere but the configured backend', async () => {
    // The service makes exactly one kind of outbound request, to a fixed
    // env-supplied host. No caller-supplied URL is ever fetched (§7.5).
    const { outbox, worker, calls } = setup();
    await enqueueConnected(outbox);
    await enqueueConnected(outbox);
    await worker.tick();
    await worker.tick();

    for (const call of calls) {
      expect(call.url).toBe(`http://backend.test:5000${WEBHOOK_PATH}`);
    }
  });

  it('normalises a backend URL with a trailing slash', async () => {
    const { outbox } = setup();
    const worker = new DeliveryWorker({
      outbox,
      backendUrl: 'http://backend.test:5000/',
      webhookSecret: SECRET,
    });
    expect(worker.targetUrl).toBe(`http://backend.test:5000${WEBHOOK_PATH}`);
  });
});
