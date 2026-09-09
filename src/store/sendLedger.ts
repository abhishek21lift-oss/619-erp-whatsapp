// Send-once bookkeeping for outbound messages.
//
// ── The failure this exists to prevent ──────────────────────────────────────
//
// The ERP delivers each message as a BullMQ job with bounded retries. A job
// that sends successfully and then loses the HTTP response — a timeout, a
// container restart between the write and the read — is retried, and without a
// ledger that retry sends the message a SECOND time. The studio's client gets
// the same reminder twice, and nothing in either service can tell that
// happened.
//
// Retrying is correct: the alternative is dropping messages on a blip. So the
// duplicate has to be stopped where the send actually happens, keyed on an id
// the caller chooses and keeps stable across its own retries.
//
// ── Why the claim is separate from the record ───────────────────────────────
//
// A single "have I sent this?" check has a window between the check and the
// send in which a concurrent retry passes the same check. `claim` is a Redis
// SET NX — atomic — so exactly one caller proceeds and the other is refused
// outright rather than racing it. The claim is then either upgraded to the
// provider's message id (`record`) or dropped (`release`) so a genuine failure
// stays retryable.

import type { Redis } from 'ioredis';
import { KEY_PREFIX } from './redis.js';

/** Written while a send is in flight, replaced by the provider's id after. */
const IN_FLIGHT = '-';

export interface SendClaim {
  /** True when this caller now owns the send and must proceed. */
  fresh: boolean;
  /**
   * The provider id from the ORIGINAL send, when this is a replay of one that
   * already completed. Null when a send is still in flight under this id.
   */
  provider_message_id: string | null;
}

export interface SendLedger {
  claim(instanceId: string, clientMessageId: string): Promise<SendClaim>;
  record(instanceId: string, clientMessageId: string, providerMessageId: string): Promise<void>;
  release(instanceId: string, clientMessageId: string): Promise<void>;
}

export function sendKey(instanceId: string, clientMessageId: string): string {
  return `${KEY_PREFIX}sent:${instanceId}:${clientMessageId}`;
}

export class RedisSendLedger implements SendLedger {
  readonly #redis: Redis;
  readonly #ttlSec: number;

  /**
   * `ttlSec` bounds how long a replay is recognised as one.
   *
   * It must comfortably outlive the ERP's whole retry ladder — three attempts
   * with exponential backoff — because a retry arriving after the entry
   * expired is indistinguishable from a first attempt and would send again.
   * It is not a permanent record: communication_logs is that, and keeping
   * every message id in Redis forever would grow without bound for a guarantee
   * that stops being useful once the job has left the queue.
   */
  constructor(redis: Redis, ttlSec: number) {
    this.#redis = redis;
    this.#ttlSec = ttlSec;
  }

  async claim(instanceId: string, clientMessageId: string): Promise<SendClaim> {
    const key = sendKey(instanceId, clientMessageId);
    const won = await this.#redis.set(key, IN_FLIGHT, 'EX', this.#ttlSec, 'NX');
    if (won === 'OK') return { fresh: true, provider_message_id: null };

    // Lost the race, or this id completed earlier. Reading the value is what
    // separates the two: a stored provider id means the original send
    // succeeded and this caller should be handed that id rather than an error.
    const existing = await this.#redis.get(key);
    return {
      fresh: false,
      provider_message_id: existing && existing !== IN_FLIGHT ? existing : null,
    };
  }

  async record(instanceId: string, clientMessageId: string, providerMessageId: string): Promise<void> {
    await this.#redis.set(sendKey(instanceId, clientMessageId), providerMessageId, 'EX', this.#ttlSec);
  }

  async release(instanceId: string, clientMessageId: string): Promise<void> {
    await this.#redis.del(sendKey(instanceId, clientMessageId));
  }
}

/**
 * A ledger that never dedupes.
 *
 * For deployments and tests with no Redis. Named for what it does rather than
 * "Null" so that choosing it is a visible decision: every send is treated as
 * fresh, which is the correct behaviour for a single attempt and the wrong one
 * under retry.
 */
export class AlwaysFreshSendLedger implements SendLedger {
  claim(): Promise<SendClaim> {
    return Promise.resolve({ fresh: true, provider_message_id: null });
  }
  record(): Promise<void> {
    return Promise.resolve();
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}
