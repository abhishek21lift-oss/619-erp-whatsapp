// The reconnection budget and its timer (architecture §5.2).
//
// Every rule here has a cost when it is wrong in one direction or the other:
// too eager and the gateway hammers WhatsApp until the number is flagged (§19);
// too reluctant and a studio silently stops receiving messages until somebody
// notices and presses a button.

import { describe, it, expect, vi } from 'vitest';
import { ReconnectScheduler } from '../domain/reconnectScheduler.js';

interface Harness {
  scheduler: ReconnectScheduler;
  retries: () => number;
  /** Run every timer that is due, in the order they were armed. */
  fire: () => void;
  armed: () => number;
}

/**
 * A scheduler over controllable timers.
 *
 * Real timers would make these tests either slow or flaky — the delays run to
 * five minutes — and `vi.useFakeTimers` would also capture the unrelated timers
 * the rest of the service arms. Injecting is narrower and clearer.
 */
function harness(options: { maxAttempts?: number; random?: () => number } = {}): Harness {
  let pending: { fn: () => void; ms: number; id: number }[] = [];
  let nextId = 1;
  let retries = 0;

  const scheduler = new ReconnectScheduler({
    baseMs: 1_000,
    maxMs: 60_000,
    maxAttempts: options.maxAttempts ?? 3,
    random: options.random ?? (() => 0.5),
    onRetry: () => {
      retries += 1;
    },
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.push({ fn, ms, id });
      return id as unknown as NodeJS.Timeout;
    },
    clearTimer: (timer) => {
      pending = pending.filter((p) => p.id !== (timer as unknown as number));
    },
  });

  return {
    scheduler,
    retries: () => retries,
    armed: () => pending.length,
    fire: () => {
      const due = pending;
      pending = [];
      for (const p of due) p.fn();
    },
  };
}

describe('ReconnectScheduler', () => {
  it('arms a retry and reports a timer that actually exists', () => {
    const h = harness();
    const result = h.scheduler.schedule();

    expect(result.willRetry).toBe(true);
    expect(result.attempt).toBe(1);
    expect(result.delayMs).toBeGreaterThan(0);
    expect(result.nextRetryAt).not.toBeNull();
    expect(h.armed()).toBe(1);

    // The ERP renders next_retry_at directly, so it must be in the future and
    // consistent with the delay — a countdown to a moment that has passed is
    // worse than no countdown.
    const eta = Date.parse(result.nextRetryAt as string);
    expect(eta).toBeGreaterThanOrEqual(Date.now() - 50);
  });

  it('invokes the retry callback when the timer comes due', () => {
    const h = harness();
    h.scheduler.schedule();
    expect(h.retries()).toBe(0);

    h.fire();
    expect(h.retries()).toBe(1);
    // The timer is spent, not re-armed by itself.
    expect(h.scheduler.pending).toBe(false);
  });

  it('gives up once the budget is spent, and says so honestly', () => {
    const h = harness({ maxAttempts: 3 });

    for (let i = 1; i <= 3; i += 1) {
      const result = h.scheduler.schedule();
      expect(result.willRetry, `attempt ${i}`).toBe(true);
      h.fire();
    }

    const exhausted = h.scheduler.schedule();
    expect(exhausted.willRetry).toBe(false);
    expect(exhausted.nextRetryAt).toBeNull();
    // Nothing armed — the caller must not be told to expect a retry that will
    // never come.
    expect(h.armed()).toBe(0);
  });

  it('never stacks two timers for one instance', () => {
    // Two armed timers means two sockets, and two sockets writing one session
    // directory is how the credentials get corrupted.
    const h = harness({ maxAttempts: 5 });
    h.scheduler.schedule();
    h.scheduler.schedule();
    h.scheduler.schedule();

    expect(h.armed()).toBe(1);
    h.fire();
    expect(h.retries()).toBe(1);
  });

  it('reset() restores the full budget — this is what makes Reconnect work', () => {
    // Without it, `failed` would be permanent and the operator's Reconnect
    // button would be a lie.
    const h = harness({ maxAttempts: 2 });
    h.scheduler.schedule();
    h.scheduler.schedule();
    expect(h.scheduler.schedule().willRetry).toBe(false);

    h.scheduler.reset();

    expect(h.scheduler.attempt).toBe(0);
    expect(h.scheduler.schedule().willRetry).toBe(true);
  });

  it('reset() cancels an armed timer', () => {
    // An operator's immediate reconnect must not be raced by the backoff timer
    // that was armed before they pressed the button — that opens two sockets.
    const h = harness();
    h.scheduler.schedule();
    expect(h.armed()).toBe(1);

    h.scheduler.reset();

    expect(h.armed()).toBe(0);
    h.fire();
    expect(h.retries()).toBe(0);
  });

  it('cancel() stops the timer but keeps the budget spent', () => {
    // Used where the instance is stopping for a reason that does not earn a
    // fresh budget — a logout, a shutdown.
    const h = harness({ maxAttempts: 3 });
    h.scheduler.schedule();
    h.scheduler.cancel();

    expect(h.armed()).toBe(0);
    expect(h.scheduler.attempt).toBe(1);
  });

  it('backs off further on each successive attempt', () => {
    const h = harness({ maxAttempts: 6, random: () => 0.999999 });

    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      delays.push(h.scheduler.schedule().delayMs as number);
      h.fire();
    }

    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!, `attempt ${i + 1} must wait longer than ${i}`).toBeGreaterThan(
        delays[i - 1]!,
      );
    }
  });

  it('unrefs its timer so a pending retry cannot hold the process open', () => {
    // Otherwise `docker compose stop` waits out the full backoff before the
    // container exits, and Docker eventually SIGKILLs it mid-shutdown.
    const unref = vi.fn();
    const scheduler = new ReconnectScheduler({
      baseMs: 1_000,
      maxMs: 10_000,
      maxAttempts: 3,
      onRetry: () => undefined,
      setTimer: () => ({ unref }) as unknown as NodeJS.Timeout,
      clearTimer: () => undefined,
    });

    scheduler.schedule();
    expect(unref).toHaveBeenCalledOnce();
  });
});
