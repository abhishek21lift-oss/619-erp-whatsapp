// Reconnection backoff (architecture §5.2).
//
// Pure and injectable so every property below is unit-testable. The alternative
// — inlining this in the connector — makes the herd-avoidance behaviour
// observable only by running fifty instances against WhatsApp, which is neither
// a test nor a thing anyone should do to find out whether their maths is right.

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  /** Injectable for tests. Must return [0, 1). */
  random?: () => number;
}

/**
 * Never retry faster than this, whatever the jitter rolls.
 *
 * Full jitter is `random(0, ceiling)`, which can legitimately return a delay of
 * a few milliseconds. That is fine for a database and wrong here: reconnecting
 * 3 ms after WhatsApp dropped the socket is not a retry, it is a hammer, and
 * hammering is one of the traffic patterns that gets a number flagged (§19).
 *
 * A documented deviation from §5.2's bare `random(0, delay)`, and a small one —
 * it only binds on the shortest rolls of the earliest attempts.
 */
export const MIN_RECONNECT_DELAY_MS = 500;

/**
 * How long to wait before reconnection attempt `attempt` (0-based).
 *
 * Exponential with **full jitter**, not fixed backoff. The difference matters
 * on exactly one occasion, and it is the occasion that hurts: when the gateway
 * restarts, or WhatsApp has a blip, every instance disconnects at the same
 * moment. Fixed backoff would then have all of them reconnect in lockstep —
 * a self-inflicted thundering herd against WhatsApp's servers, from a single
 * IP, which is precisely the shape of traffic that gets an IP rate-limited.
 * Spreading the retries across the window makes fifty studios look like fifty
 * people rather than one script.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;

  // `2 ** attempt` overflows to Infinity around attempt 1024, and
  // Infinity * 0 is NaN — which would silently become a delay of NaN and a
  // timer that fires immediately, forever. Clamped well below that: 2^30
  // already exceeds any sane ceiling by orders of magnitude.
  const exponent = Math.min(Math.max(attempt, 0), 30);
  const ceiling = Math.min(options.baseMs * 2 ** exponent, options.maxMs);

  return Math.max(MIN_RECONNECT_DELAY_MS, Math.floor(random() * ceiling));
}

/**
 * The WORST-CASE time an instance spends reconnecting before it gives up: the
 * sum of every attempt's ceiling, i.e. every jitter roll landing at the top.
 *
 * Exists for the operator-facing docs, and it earns its place: §5.2 originally
 * claimed "roughly 25 minutes" for the defaults. It is 18.5. An operator who
 * reads 25, waits 20 and then restarts the container has been misled by the
 * documentation rather than the code — so the number is computed here and
 * pinned by a test instead of being asserted in prose.
 *
 * With full jitter each delay averages half its ceiling, so the time an
 * operator actually observes is nearer `expectedBackoffWindowMs` below.
 */
export function maxBackoffWindowMs(maxAttempts: number, options: BackoffOptions): number {
  let total = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const exponent = Math.min(Math.max(attempt, 0), 30);
    total += Math.min(options.baseMs * 2 ** exponent, options.maxMs);
  }
  return total;
}

/**
 * The TYPICAL time before an instance gives up — the number worth quoting.
 *
 * Full jitter draws uniformly from [0, ceiling], so each attempt averages half
 * its ceiling. For the defaults that is ~9 minutes, not the 18.5 worst case and
 * certainly not the 25 the design originally claimed.
 */
export function expectedBackoffWindowMs(maxAttempts: number, options: BackoffOptions): number {
  return maxBackoffWindowMs(maxAttempts, options) / 2;
}
