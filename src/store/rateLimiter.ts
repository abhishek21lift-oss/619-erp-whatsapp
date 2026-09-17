// Per-instance outbound send rate limiting (architecture §18, "Send").
//
// ── The gap this closes ─────────────────────────────────────────────────────
//
// The only rate limiting actually wired up before this was `@fastify/rate-
// limit` on the API layer (app.ts) — a generic per-org cap on HOW OFTEN the
// ERP may CALL this service, meant to guard against a runaway poll loop. It
// says nothing about outbound WhatsApp SEND VOLUME. A backend bug or a
// compromised caller invoking `POST /v1/instances/:id/messages` in a tight
// loop had no gateway-side guardrail against "fixed-interval sending is a
// machine signature" (§19) — exactly the pattern that gets a WhatsApp number
// banned.
//
// ── Token bucket, atomically ────────────────────────────────────────────────
//
// Refill and consume happen in one Lua script so two concurrent sends on the
// same instance cannot both read "1 token left" and both proceed — the same
// class of race the send-once ledger (sendLedger.ts) closes with a Redis
// SET NX. A bucket is per instance, stored as a hash of {tokens, ts}; tokens
// refill continuously (not once a minute), so a burst is available immediately
// after startup rather than after waiting out the first window.
//
// A daily counter, separate from the bucket, is the backstop against a
// runaway automation that would otherwise trickle-send at exactly the
// sustained rate forever.

import type { Redis } from 'ioredis';
import { KEY_PREFIX } from './redis.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** Only meaningful when `allowed` is false. */
  retryAfterMs: number;
  reason?: 'burst' | 'daily_cap';
}

export interface SendRateLimiter {
  check(instanceId: string): Promise<RateLimitDecision>;
}

export function rateLimitBucketKey(instanceId: string): string {
  return `${KEY_PREFIX}ratelimit:${instanceId}`;
}

export function rateLimitDailyKey(instanceId: string): string {
  return `${KEY_PREFIX}ratelimit:${instanceId}:daily`;
}

/**
 * KEYS[1] = bucket hash key
 * KEYS[2] = daily counter key
 * ARGV[1] = now (ms, epoch)
 * ARGV[2] = burst capacity (tokens)
 * ARGV[3] = refill rate (tokens per ms)
 * ARGV[4] = daily cap
 * ARGV[5] = bucket key TTL (seconds) — a few minutes past full refill, so an
 *           idle instance's bucket does not linger in Redis forever
 * ARGV[6] = daily key TTL (seconds) — 24h
 *
 * Returns { allowed: 1|0, retryAfterMs: number, dailyCount: number }.
 */
/** Exported so a test fake can recognise this exact script rather than a real Lua engine. */
export const TOKEN_BUCKET_SCRIPT = `
local bucketKey = KEYS[1]
local dailyKey = KEYS[2]
local now = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local refillPerMs = tonumber(ARGV[3])
local dailyCap = tonumber(ARGV[4])
local bucketTtl = tonumber(ARGV[5])
local dailyTtl = tonumber(ARGV[6])

local daily = tonumber(redis.call('GET', dailyKey) or '0')
if daily >= dailyCap then
  return {0, -1, daily}
end

local state = redis.call('HMGET', bucketKey, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then
  tokens = burst
  ts = now
end

local elapsed = now - ts
if elapsed > 0 then
  tokens = math.min(burst, tokens + (elapsed * refillPerMs))
  ts = now
end

if tokens < 1 then
  local deficit = 1 - tokens
  local retryAfterMs = math.ceil(deficit / refillPerMs)
  redis.call('HMSET', bucketKey, 'tokens', tokens, 'ts', ts)
  redis.call('EXPIRE', bucketKey, bucketTtl)
  return {0, retryAfterMs, daily}
end

tokens = tokens - 1
redis.call('HMSET', bucketKey, 'tokens', tokens, 'ts', ts)
redis.call('EXPIRE', bucketKey, bucketTtl)

local newDaily = redis.call('INCR', dailyKey)
if newDaily == 1 then
  redis.call('EXPIRE', dailyKey, dailyTtl)
end

return {1, 0, newDaily}
`;

export interface RateLimiterOptions {
  /** Sustained rate, e.g. 20 messages/minute. */
  sustainedPerMinute: number;
  /** Burst capacity — tokens available immediately, before sustained refill applies. */
  burst: number;
  /** Hard daily cap per instance. */
  dailyCap: number;
}

export class RedisSendRateLimiter implements SendRateLimiter {
  readonly #redis: Redis;
  readonly #burst: number;
  readonly #refillPerMs: number;
  readonly #dailyCap: number;
  readonly #bucketTtlSec: number;

  constructor(redis: Redis, opts: RateLimiterOptions) {
    this.#redis = redis;
    this.#burst = opts.burst;
    this.#refillPerMs = opts.sustainedPerMinute / 60_000;
    this.#dailyCap = opts.dailyCap;
    // Time to refill the whole bucket from empty, plus a couple of minutes —
    // long enough that a mid-refill bucket never expires early, short enough
    // that an instance idle for hours does not hold a Redis key forever.
    this.#bucketTtlSec = Math.ceil(opts.burst / (opts.sustainedPerMinute / 60)) + 120;
  }

  async check(instanceId: string): Promise<RateLimitDecision> {
    const [allowed, retryAfterMs] = (await this.#redis.eval(
      TOKEN_BUCKET_SCRIPT,
      2,
      rateLimitBucketKey(instanceId),
      rateLimitDailyKey(instanceId),
      Date.now(),
      this.#burst,
      this.#refillPerMs,
      this.#dailyCap,
      this.#bucketTtlSec,
      24 * 3600,
    )) as [number, number, number];

    if (allowed === 1) return { allowed: true, retryAfterMs: 0 };
    return {
      allowed: false,
      retryAfterMs: retryAfterMs < 0 ? 24 * 3600 * 1000 : retryAfterMs,
      reason: retryAfterMs < 0 ? 'daily_cap' : 'burst',
    };
  }
}

/**
 * A limiter that never throttles.
 *
 * For deployments and tests with no Redis. Named for what it does, the same
 * way AlwaysFreshSendLedger is — choosing it is a visible decision, not a
 * silent default.
 */
export class AlwaysAllowSendRateLimiter implements SendRateLimiter {
  check(): Promise<RateLimitDecision> {
    return Promise.resolve({ allowed: true, retryAfterMs: 0 });
  }
}
