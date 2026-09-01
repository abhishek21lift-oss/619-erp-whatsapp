// The per-instance reconnection budget and timer (architecture §5.2).
//
// Extracted from the connector rather than inlined there, because every
// interesting property of the reconnect loop — the budget running out, a
// success restoring it, an operator's reconnect cancelling an armed timer —
// is otherwise reachable only through a live WhatsApp socket. That would make
// the lifecycle rules the least-tested code in the service instead of the
// most, which is backwards: getting them wrong either strands a studio offline
// or hammers WhatsApp until the number is flagged.

import { backoffDelayMs } from './backoff.js';

export interface ReconnectSchedulerOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
  /** Invoked when a scheduled attempt comes due. */
  onRetry: () => void;
  /** Injectable for tests. */
  random?: () => number;
  setTimer?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export interface ScheduleResult {
  willRetry: boolean;
  nextRetryAt: string | null;
  /** 1-based, for logging. Zero when the budget was already spent. */
  attempt: number;
  delayMs: number | null;
}

export class ReconnectScheduler {
  readonly #options: Required<Omit<ReconnectSchedulerOptions, 'onRetry'>> & { onRetry: () => void };
  #attempt = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(options: ReconnectSchedulerOptions) {
    this.#options = {
      random: Math.random,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (timer) => clearTimeout(timer),
      ...options,
    };
  }

  /** Attempts spent since the last success or reset. */
  get attempt(): number {
    return this.#attempt;
  }

  /** True while a retry is armed and waiting. */
  get pending(): boolean {
    return this.#timer !== undefined;
  }

  /**
   * Arm the next attempt, or report that the budget is spent.
   *
   * The return value is what the ERP is told, so `willRetry` and `nextRetryAt`
   * always describe a timer that actually exists. The UI renders these
   * directly: promising a retry that was never scheduled leaves a studio
   * watching a countdown to nothing.
   */
  schedule(): ScheduleResult {
    if (this.#attempt >= this.#options.maxAttempts) {
      return { willRetry: false, nextRetryAt: null, attempt: 0, delayMs: null };
    }

    const delayMs = backoffDelayMs(this.#attempt, {
      baseMs: this.#options.baseMs,
      maxMs: this.#options.maxMs,
      random: this.#options.random,
    });
    this.#attempt += 1;

    // Replace, never stack. Two armed timers for one instance would open two
    // sockets, and two sockets writing one session directory is how the
    // credentials get corrupted.
    this.cancel();
    const timer = this.#options.setTimer(() => {
      this.#timer = undefined;
      this.#options.onRetry();
    }, delayMs);
    // A pending reconnect must never hold the process open during shutdown.
    timer.unref?.();
    this.#timer = timer;

    return {
      willRetry: true,
      nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
      attempt: this.#attempt,
      delayMs,
    };
  }

  /**
   * Cancel any armed timer, keeping the attempt count.
   *
   * Used where the instance is stopping for a reason that does not earn a
   * fresh budget — a logout, a shutdown.
   */
  cancel(): void {
    if (this.#timer !== undefined) {
      this.#options.clearTimer(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Cancel and restore the full budget.
   *
   * Called on a successful connection and on an operator's explicit reconnect.
   * Both mean "start counting again": without the first, an instance that
   * flapped nine times over a month would give up on its tenth ever
   * disconnect; without the second, `failed` would be permanent and the
   * Reconnect button a lie.
   */
  reset(): void {
    this.cancel();
    this.#attempt = 0;
  }
}
