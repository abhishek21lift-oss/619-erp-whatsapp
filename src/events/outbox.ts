// The event outbox (architecture §11.2).
//
// Phase 2 implements the PRODUCER half — enqueue, depth, and the crash-recovery
// sweep. The delivery worker that drains it to the backend's webhook is Phase 6;
// until then events accumulate in Redis, which is the correct behaviour for a
// service whose consumer does not exist yet, and is observable via `depth()`.
//
// ── Why a Redis list rather than BullMQ ─────────────────────────────────────
//
// BullMQ is the ERP's queue. Pointing a second service's producers at it would
// put this service inside `bullmq.connections.test.js`'s invariants about
// connection counts and worker ownership, for no gain: this is one queue, with
// one producer and one consumer, and no need for priorities, repeatable jobs or
// a job graph. A list is the right size for it.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { keys } from '../store/redis.js';
import type { GatewayEvent, EventTypeValue, EventPayloads } from './schema.js';
import { buildEvent } from './schema.js';
import { operationLogger } from '../logger.js';

/**
 * How long an event may sit in the processing list before the sweeper assumes
 * the deliverer died and returns it to the main queue.
 *
 * Comfortably longer than a delivery attempt (a 10s HTTP timeout plus retries)
 * so a slow-but-alive deliverer is not raced by the sweeper, which would
 * deliver the same event twice for no reason. Duplicates are safe — the
 * backend's ledger absorbs them — but they should be caused by real failures,
 * not by our own impatience.
 */
export const PROCESSING_RECLAIM_MS = 60_000;

export interface Envelope {
  event: GatewayEvent;
  enqueued_at: number;
  attempts: number;
}

/** One claimed item: the exact string in Redis, plus its parsed form. */
export interface ClaimedEvent {
  /** The verbatim member — LREM matches by value, so it must not be re-encoded. */
  raw: string;
  envelope: Envelope;
}

/**
 * The write side, as an interface — same reasoning as QrReader in store/qr.ts:
 * the registry's ownership and lifecycle tests must be runnable without Redis.
 */
export interface EventSink {
  enqueue<T extends EventTypeValue>(
    eventType: T,
    args: {
      instanceId: string;
      tenantId: string;
      payload: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<GatewayEvent>;
}

export class Outbox implements EventSink {
  readonly #redis: Redis;

  constructor(redis: Redis) {
    this.#redis = redis;
  }

  /**
   * Enqueue one event for at-least-once delivery.
   *
   * LPUSH pairs with the consumer's BRPOPLPUSH so the list is drained oldest
   * first. Events are appended, never coalesced: two `disconnected` events in a
   * row are two real transitions and the backend's row should reflect both.
   */
  async enqueue<T extends EventTypeValue>(
    eventType: T,
    args: {
      instanceId: string;
      tenantId: string;
      payload: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
      occurredAt?: Date;
    },
  ): Promise<GatewayEvent> {
    const event = buildEvent(eventType, {
      eventId: randomUUID(),
      instanceId: args.instanceId,
      tenantId: args.tenantId,
      payload: args.payload,
      ...(args.occurredAt ? { occurredAt: args.occurredAt } : {}),
    });

    const envelope: Envelope = { event, enqueued_at: Date.now(), attempts: 0 };
    await this.#redis.lpush(keys.outbox, JSON.stringify(envelope));

    operationLogger({
      instance_id: event.instance_id,
      tenant_id: event.tenant_id,
      event_id: event.event_id,
      operation: 'outbox.enqueue',
    }).info({ event_type: event.event_type, status: 'ok' }, 'event_enqueued');

    return event;
  }

  async depth(): Promise<{
    pending: number;
    processing: number;
    retrying: number;
    dead: number;
  }> {
    const [pending, processing, retrying, dead] = await Promise.all([
      this.#redis.llen(keys.outbox),
      this.#redis.llen(keys.outboxProcessing),
      this.#redis.zcard(keys.outboxRetry),
      this.#redis.llen(keys.outboxDead),
    ]);
    return { pending, processing, retrying, dead };
  }

  /**
   * Move any retries that have come due back onto the ready queue.
   *
   * ZREM before LPUSH, and only push when ZREM actually removed something.
   * Two delivery loops (or a loop racing its own next tick) would otherwise
   * both see the same due member and enqueue it twice — the ZREM result is the
   * atomic claim.
   */
  async promoteDueRetries(now = Date.now(), limit = 100): Promise<number> {
    const due = await this.#redis.zrangebyscore(
      keys.outboxRetry,
      '-inf',
      now,
      'LIMIT',
      0,
      limit,
    );
    let promoted = 0;
    for (const raw of due) {
      const claimed = await this.#redis.zrem(keys.outboxRetry, raw);
      if (claimed === 1) {
        await this.#redis.lpush(keys.outbox, raw);
        promoted += 1;
      }
    }
    return promoted;
  }

  /**
   * Claim the next ready event, moving it to the processing list.
   *
   * RPOPLPUSH is atomic: the event is never in neither list, so a crash at any
   * instant leaves it recoverable by `reclaimStale`. Non-blocking on purpose —
   * see DeliveryWorker for why this service polls rather than using BRPOPLPUSH.
   */
  async claimNext(): Promise<ClaimedEvent | undefined> {
    const raw = await this.#redis.rpoplpush(keys.outbox, keys.outboxProcessing);
    if (raw === null) return undefined;

    try {
      return { raw, envelope: JSON.parse(raw) as Envelope };
    } catch {
      // Unparseable: it can never be delivered, and leaving it in processing
      // means sweeping it forever. Dead-letter it where it is visible.
      await this.#redis.lrem(keys.outboxProcessing, 1, raw);
      await this.#redis.lpush(keys.outboxDead, raw);
      return undefined;
    }
  }

  /** Delivery succeeded — drop it from the processing list. */
  async ack(claimed: ClaimedEvent): Promise<void> {
    await this.#redis.lrem(keys.outboxProcessing, 1, claimed.raw);
  }

  /**
   * Delivery failed but is worth another go: schedule it for `dueAt`.
   *
   * The attempt counter is incremented in the stored envelope, so it survives a
   * gateway restart. Counting in memory instead would reset the budget on every
   * deploy and let a permanently-failing event retry forever.
   */
  async scheduleRetry(claimed: ClaimedEvent, dueAt: number): Promise<void> {
    const next: Envelope = { ...claimed.envelope, attempts: claimed.envelope.attempts + 1 };
    await this.#redis.lrem(keys.outboxProcessing, 1, claimed.raw);
    await this.#redis.zadd(keys.outboxRetry, dueAt, JSON.stringify(next));
  }

  /**
   * Out of attempts. Preserved rather than dropped.
   *
   * A dead-lettered event is a message the ERP never received, so its row is
   * now wrong and somebody has to know. `wa_outbox_dead` is one of the two
   * metrics §14.4 says should page.
   */
  async deadLetter(claimed: ClaimedEvent): Promise<void> {
    const final: Envelope = { ...claimed.envelope, attempts: claimed.envelope.attempts + 1 };
    await this.#redis.lrem(keys.outboxProcessing, 1, claimed.raw);
    await this.#redis.lpush(keys.outboxDead, JSON.stringify(final));
  }

  /**
   * Return events stranded in the processing list back to the main queue.
   *
   * A deliverer that crashes between BRPOPLPUSH and the acknowledging LREM
   * leaves its event in `processing` with nobody looking at it. Without this
   * sweep that event is lost silently — the failure mode the reliable-queue
   * pattern exists to prevent, and it only actually prevents it if something
   * runs this.
   *
   * Returns how many were reclaimed, so the caller can log a non-zero result:
   * a steady trickle of reclaims means deliveries are dying mid-flight, which
   * is worth knowing before the dead-letter list starts filling.
   */
  async reclaimStale(now = Date.now()): Promise<number> {
    const stranded = await this.#redis.lrange(keys.outboxProcessing, 0, -1);
    let reclaimed = 0;

    for (const raw of stranded) {
      let envelope: Envelope;
      try {
        envelope = JSON.parse(raw) as Envelope;
      } catch {
        // Unparseable: it can never be delivered, and leaving it in place means
        // sweeping it forever. Move it to dead-letter where it is visible.
        await this.#redis.lrem(keys.outboxProcessing, 1, raw);
        await this.#redis.lpush(keys.outboxDead, raw);
        continue;
      }

      if (now - envelope.enqueued_at < PROCESSING_RECLAIM_MS) continue;

      // LREM before LPUSH. The other order can duplicate the event if the
      // process dies between the two; this order can only lose the reclaim
      // attempt, which the next sweep repeats.
      const removed = await this.#redis.lrem(keys.outboxProcessing, 1, raw);
      if (removed > 0) {
        await this.#redis.lpush(keys.outbox, raw);
        reclaimed += 1;
      }
    }

    return reclaimed;
  }
}
