// Reconnection backoff (architecture §5.2).
//
// The behaviour that matters most here is the one hardest to see: full jitter.
// It only pays off when every instance disconnects at the same moment — a
// gateway restart, or a WhatsApp blip — and the cost of getting it wrong is a
// self-inflicted thundering herd from a single IP, which is exactly the traffic
// shape that gets an IP rate-limited. So it is tested by simulation rather than
// by asserting one delay.

import { describe, it, expect } from 'vitest';
import {
  backoffDelayMs,
  maxBackoffWindowMs,
  expectedBackoffWindowMs,
  MIN_RECONNECT_DELAY_MS,
} from '../domain/backoff.js';

const DEFAULTS = { baseMs: 2_000, maxMs: 300_000 };

/** A deterministic stand-in for Math.random. */
const fixed = (value: number) => () => value;

describe('backoffDelayMs', () => {
  it('grows exponentially — the ceiling doubles each attempt', () => {
    // random() = 1 would exceed the range, so 0.999… stands in for "the top of
    // the window" and shows the ceiling itself.
    const top = fixed(0.999999);
    const delays = [0, 1, 2, 3, 4].map((n) =>
      backoffDelayMs(n, { ...DEFAULTS, random: top }),
    );

    expect(delays[0]).toBeLessThan(2_000);
    expect(delays[1]).toBeLessThan(4_000);
    expect(delays[2]).toBeLessThan(8_000);
    // Strictly increasing ceilings.
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('never exceeds the configured ceiling', () => {
    for (const attempt of [0, 5, 10, 20, 50, 1000]) {
      const delay = backoffDelayMs(attempt, { ...DEFAULTS, random: fixed(0.999999) });
      expect(delay, `attempt ${attempt}`).toBeLessThanOrEqual(DEFAULTS.maxMs);
    }
  });

  it('never returns NaN or Infinity for an absurd attempt count', () => {
    // `2 ** attempt` overflows to Infinity around 1024, and Infinity * 0 is
    // NaN — which becomes a timer that fires immediately, forever. The exponent
    // is clamped so this cannot happen.
    for (const attempt of [1024, 5000, Number.MAX_SAFE_INTEGER]) {
      const delay = backoffDelayMs(attempt, { ...DEFAULTS, random: fixed(0) });
      expect(Number.isFinite(delay), `attempt ${attempt}`).toBe(true);
      expect(Number.isNaN(delay), `attempt ${attempt}`).toBe(false);
    }
  });

  it('never retries faster than the floor, even on a zero roll', () => {
    // Full jitter can legitimately roll near zero. Reconnecting 3ms after
    // WhatsApp dropped the socket is not a retry, it is a hammer.
    for (const attempt of [0, 1, 5]) {
      expect(backoffDelayMs(attempt, { ...DEFAULTS, random: fixed(0) })).toBe(
        MIN_RECONNECT_DELAY_MS,
      );
    }
  });

  it('treats a negative attempt as the first one rather than misbehaving', () => {
    const delay = backoffDelayMs(-5, { ...DEFAULTS, random: fixed(0.5) });
    expect(delay).toBe(backoffDelayMs(0, { ...DEFAULTS, random: fixed(0.5) }));
  });

  it('spreads a simultaneous herd across the window instead of bunching it', () => {
    // The property the jitter exists for. Fifty instances all disconnect at
    // once and all schedule attempt 3. With fixed backoff every one of them
    // would fire at the same millisecond.
    const delays = Array.from({ length: 50 }, () => backoffDelayMs(3, DEFAULTS));

    const unique = new Set(delays).size;
    expect(unique, 'delays must not all collide').toBeGreaterThan(40);

    // And they should actually be spread, not merely distinct: the gap between
    // the earliest and latest retry should cover a large part of the window.
    const spread = Math.max(...delays) - Math.min(...delays);
    expect(spread).toBeGreaterThan(0.5 * DEFAULTS.baseMs * 2 ** 3);
  });

  it('stays within [floor, ceiling] across many real random rolls', () => {
    const ceiling = Math.min(DEFAULTS.baseMs * 2 ** 4, DEFAULTS.maxMs);
    for (let i = 0; i < 500; i += 1) {
      const delay = backoffDelayMs(4, DEFAULTS);
      expect(delay).toBeGreaterThanOrEqual(MIN_RECONNECT_DELAY_MS);
      expect(delay).toBeLessThanOrEqual(ceiling);
    }
  });
});

describe('backoff window', () => {
  // These pin the numbers the operator-facing docs quote, so the two cannot
  // drift apart silently. §5.2 originally claimed "roughly 25 minutes"; this
  // test is what caught that it is 18.5 in the worst case and ~9 typically.
  it('worst case is 18.5 minutes for the documented defaults', () => {
    expect(maxBackoffWindowMs(10, DEFAULTS)).toBe(1_110_000);
    expect(maxBackoffWindowMs(10, DEFAULTS) / 60_000).toBeCloseTo(18.5, 1);
  });

  it('typical case is about half that, because of the jitter', () => {
    // The number worth quoting to an operator: full jitter draws uniformly
    // from [0, ceiling], so each attempt averages half its ceiling.
    expect(expectedBackoffWindowMs(10, DEFAULTS) / 60_000).toBeCloseTo(9.25, 1);
  });

  it('matches a simulated run within a sensible margin', () => {
    // Belt and braces: the closed-form expectation should agree with actually
    // rolling the dice, or the formula is describing a different algorithm
    // from the one that runs.
    const RUNS = 2_000;
    let total = 0;
    for (let run = 0; run < RUNS; run += 1) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        total += backoffDelayMs(attempt, DEFAULTS);
      }
    }
    const simulatedMean = total / RUNS;
    const predicted = expectedBackoffWindowMs(10, DEFAULTS);
    expect(Math.abs(simulatedMean - predicted) / predicted).toBeLessThan(0.05);
  });
});
