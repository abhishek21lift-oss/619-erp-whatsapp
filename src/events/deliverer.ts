// The outbox delivery worker (architecture §8.4).
//
// Drains `wa:outbox` to the backend's webhook, signing every request and
// retrying with bounded exponential backoff.
//
// ── Why this polls instead of using BRPOPLPUSH ──────────────────────────────
//
// The reliable-queue pattern usually reaches for BRPOPLPUSH, and §11.2 names
// it. But a blocking command occupies its Redis connection for the whole block,
// so ioredis queues every other command behind it — the QR writes, the instance
// locks, the depth reads. Avoiding that needs a second, dedicated connection,
// which is exactly the complexity the ERP's lib/redis.js carries for its BullMQ
// workers.
//
// It is not worth it here. This loop drains at full speed while there is work
// (it only sleeps once the queue is empty), so the poll interval is the latency
// on an IDLE queue — and on an idle queue nobody is waiting. One connection,
// no blocking command that can wedge the rest of the service, and a loop that
// can be stepped one tick at a time in a test.

import { operationLogger } from '../logger.js';
import { backoffDelayMs } from '../domain/backoff.js';
import { signBody, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from './signing.js';
import type { ClaimedEvent, Outbox } from './outbox.js';

export interface DelivererOptions {
  outbox: Outbox;
  /** The ONLY host this service posts to. A fixed value — see §7.5 (SSRF). */
  backendUrl: string;
  webhookSecret: string;
  /** Attempts per event before dead-lettering. §8.4 says 6. */
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  requestTimeoutMs?: number;
  /** How long to sleep once the queue is empty. */
  idlePollMs?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const DEFAULTS = {
  maxAttempts: 6,
  retryBaseMs: 2_000,
  retryMaxMs: 64_000,
  requestTimeoutMs: 10_000,
  idlePollMs: 1_000,
};

/** The path the backend mounts its receiver on (Phase 7). */
export const WEBHOOK_PATH = '/api/webhooks/whatsapp';

export class DeliveryWorker {
  readonly #outbox: Outbox;
  readonly #url: string;
  readonly #secret: string;
  readonly #maxAttempts: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #requestTimeoutMs: number;
  readonly #idlePollMs: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  #running = false;
  #loop: Promise<void> | undefined;

  constructor(options: DelivererOptions) {
    this.#outbox = options.outbox;
    this.#url = `${options.backendUrl.replace(/\/+$/, '')}${WEBHOOK_PATH}`;
    this.#secret = options.webhookSecret;
    this.#maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULTS.retryBaseMs;
    this.#retryMaxMs = options.retryMaxMs ?? DEFAULTS.retryMaxMs;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    this.#idlePollMs = options.idlePollMs ?? DEFAULTS.idlePollMs;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  get targetUrl(): string {
    return this.#url;
  }

  /**
   * Deliver one event.
   *
   * Returns whether the queue might still hold work, so the caller can drain
   * without sleeping. Never throws: this runs in a loop that must survive a
   * malformed event, an unreachable backend and a Redis blip alike.
   */
  async tick(): Promise<{ didWork: boolean }> {
    try {
      await this.#outbox.promoteDueRetries(this.#now());
    } catch (err) {
      operationLogger({ operation: 'outbox.promote' }).error(
        { status: 'error', err: (err as Error).message },
        'retry_promotion_failed',
      );
      return { didWork: false };
    }

    let claimed: ClaimedEvent | undefined;
    try {
      claimed = await this.#outbox.claimNext();
    } catch (err) {
      operationLogger({ operation: 'outbox.claim' }).error(
        { status: 'error', err: (err as Error).message },
        'outbox_claim_failed',
      );
      return { didWork: false };
    }
    if (!claimed) return { didWork: false };

    await this.#deliver(claimed);
    return { didWork: true };
  }

  async #deliver(claimed: ClaimedEvent): Promise<void> {
    const { event, attempts } = claimed.envelope;
    const log = operationLogger({
      instance_id: event.instance_id,
      tenant_id: event.tenant_id,
      event_id: event.event_id,
      operation: 'webhook.deliver',
    });

    const started = this.#now();
    const body = JSON.stringify(event);
    const { signature, timestamp } = signBody(body, this.#secret);

    let outcome: 'ok' | 'retry' | 'dead';
    let detail: Record<string, unknown> = {};

    try {
      const response = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signature,
          [TIMESTAMP_HEADER]: timestamp,
          // Also in the body. Duplicated in a header so the backend can check
          // its idempotency ledger before parsing — and, more usefully, so a
          // request is greppable in an access log without its body.
          [EVENT_ID_HEADER]: event.event_id,
        },
        body,
        // Bounded, always. A hanging backend would otherwise pin this loop and
        // stall every other event behind one dead request.
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });

      if (response.ok) {
        outcome = 'ok';
        detail = { status_code: response.status };
      } else {
        // A 4xx is not retried differently from a 5xx, deliberately. The one
        // 4xx the backend is expected to return is 401 on a signature mismatch,
        // which in practice means the secrets have drifted between the two
        // containers — a deploy error that WILL be fixed, and the event should
        // still be waiting when it is.
        outcome = attempts + 1 >= this.#maxAttempts ? 'dead' : 'retry';
        detail = { status_code: response.status };
      }
    } catch (err) {
      outcome = attempts + 1 >= this.#maxAttempts ? 'dead' : 'retry';
      detail = { err: (err as Error).message };
    }

    const durationMs = this.#now() - started;

    try {
      if (outcome === 'ok') {
        await this.#outbox.ack(claimed);
        log.info(
          { status: 'ok', event_type: event.event_type, duration_ms: durationMs, ...detail },
          'webhook_delivered',
        );
        return;
      }

      if (outcome === 'dead') {
        await this.#outbox.deadLetter(claimed);
        // `error`, not `warn`: a dead-lettered event is a state change the ERP
        // never received, so its row is now wrong and somebody has to know.
        log.error(
          {
            status: 'error',
            event_type: event.event_type,
            attempts: attempts + 1,
            duration_ms: durationMs,
            ...detail,
          },
          'webhook_dead_lettered',
        );
        return;
      }

      const delayMs = backoffDelayMs(attempts, {
        baseMs: this.#retryBaseMs,
        maxMs: this.#retryMaxMs,
      });
      await this.#outbox.scheduleRetry(claimed, this.#now() + delayMs);
      log.warn(
        {
          status: 'error',
          event_type: event.event_type,
          attempt: attempts + 1,
          retry_in_ms: delayMs,
          duration_ms: durationMs,
          ...detail,
        },
        'webhook_delivery_failed',
      );
    } catch (err) {
      // Redis failed while recording the outcome. The event stays in the
      // processing list and `reclaimStale` returns it — which is exactly the
      // case that sweeper exists for, so this is loud but not lost.
      log.error(
        { status: 'error', err: (err as Error).message },
        'webhook_outcome_not_recorded',
      );
    }
  }

  /** Start the drain loop. Idempotent. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#loop = this.#run();
    operationLogger({ operation: 'webhook.worker' }).info(
      { status: 'ok', target: this.#url },
      'delivery_worker_started',
    );
  }

  async #run(): Promise<void> {
    while (this.#running) {
      let didWork = false;
      try {
        ({ didWork } = await this.tick());
      } catch (err) {
        // tick() is already defensive; this is the last line against an
        // unanticipated throw taking the loop — and therefore every future
        // event — down with it.
        operationLogger({ operation: 'webhook.worker' }).error(
          { status: 'error', err: (err as Error).message },
          'delivery_loop_error',
        );
      }
      if (!didWork) await this.#sleep(this.#idlePollMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      // Unref'd: a sleeping deliverer must not hold the process open while
      // Docker is waiting for it to exit.
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }

  /**
   * Stop the loop and wait for the in-flight tick.
   *
   * Awaiting matters: exiting mid-delivery leaves the event in the processing
   * list until the sweeper reclaims it a minute later, which is recoverable but
   * needlessly delays a state change the ERP is waiting for.
   */
  async stop(): Promise<void> {
    this.#running = false;
    await this.#loop?.catch(() => undefined);
    this.#loop = undefined;
  }
}
