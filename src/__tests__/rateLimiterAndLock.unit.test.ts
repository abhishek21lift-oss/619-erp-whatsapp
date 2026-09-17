// Unit tests for the two Redis-backed primitives introduced by the deep
// audit: RedisSendRateLimiter (a per-instance send token bucket + daily cap,
// architecture §18) and RedisInstanceLock (the single-owner lock, §11.3).
//
// Both run their real logic as a Lua script (redis.eval), for the same
// reason sendLedger's claim() is a bare Redis SET NX: the check and the act
// must be atomic, or two concurrent callers can both read "allowed" before
// either commits. Real Lua needs a real Redis, and this suite — like the rest
// of this repo (see fakeRedis.ts's own header) — deliberately runs with none,
// so this fake reimplements the exact two scripts' semantics in JS rather
// than delegating to a real Lua engine. It recognises a script by reference
// equality with the constant the production code exports, not by pattern-
// matching Lua source, so it cannot silently diverge from a script that gets
// edited without the test being touched — a change to either script here
// fails this fake's `eval` with "unrecognised script" instead of quietly
// testing stale behaviour.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import {
  RedisSendRateLimiter,
  TOKEN_BUCKET_SCRIPT,
} from '../store/rateLimiter.js';
import {
  RedisInstanceLock,
  REFRESH_SCRIPT,
  RELEASE_SCRIPT,
  instanceLockKey,
} from '../store/instanceLock.js';

class FakeLockRateRedis {
  readonly strings = new Map<string, { value: string; expiresAt: number | null }>();
  readonly buckets = new Map<string, { tokens: number; ts: number }>();

  #get(key: string): string | null {
    const entry = this.strings.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.strings.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    const nx = args.some((a) => String(a).toUpperCase() === 'NX');
    const exIndex = args.findIndex((a) => String(a).toUpperCase() === 'EX');
    const ttlSec = exIndex !== -1 ? Number(args[exIndex + 1]) : null;
    if (nx && this.#get(key) !== null) return Promise.resolve(null);
    this.strings.set(key, { value, expiresAt: ttlSec != null ? Date.now() + ttlSec * 1000 : null });
    return Promise.resolve('OK');
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#get(key));
  }

  eval(script: string, numKeys: number, ...rest: unknown[]): Promise<unknown> {
    const keys = rest.slice(0, numKeys) as string[];
    const argv = rest.slice(numKeys);

    if (script === REFRESH_SCRIPT) {
      const [key] = keys as [string];
      const [ownerId, ttlSec] = argv as [string, number];
      if (this.#get(key) !== ownerId) return Promise.resolve(0);
      this.strings.set(key, { value: ownerId, expiresAt: Date.now() + Number(ttlSec) * 1000 });
      return Promise.resolve(1);
    }

    if (script === RELEASE_SCRIPT) {
      const [key] = keys as [string];
      const [ownerId] = argv as [string];
      if (this.#get(key) !== ownerId) return Promise.resolve(0);
      this.strings.delete(key);
      return Promise.resolve(1);
    }

    if (script === TOKEN_BUCKET_SCRIPT) {
      // Tuple casts, not bare destructuring: tsconfig.check.json (the config
      // CI type-checks tests with) sets noUncheckedIndexedAccess, so every
      // element would otherwise be `T | undefined`. The production code calls
      // eval() with exactly this arity, which is what makes the cast honest.
      const [bucketKey, dailyKey] = keys as [string, string];
      const [now, burst, refillPerMs, dailyCap, , dailyTtlSec] =
        (argv as unknown[]).map(Number) as [number, number, number, number, number, number];

      const dailyRaw = this.#get(dailyKey);
      const daily = dailyRaw != null ? Number(dailyRaw) : 0;
      if (daily >= dailyCap) return Promise.resolve([0, -1, daily]);

      const existing = this.buckets.get(bucketKey);
      let tokens = existing ? existing.tokens : burst;
      let ts = existing ? existing.ts : now;
      const elapsed = now - ts;
      if (elapsed > 0) {
        tokens = Math.min(burst, tokens + elapsed * refillPerMs);
        ts = now;
      }

      if (tokens < 1) {
        this.buckets.set(bucketKey, { tokens, ts });
        const retryAfterMs = Math.ceil((1 - tokens) / refillPerMs);
        return Promise.resolve([0, retryAfterMs, daily]);
      }

      tokens -= 1;
      this.buckets.set(bucketKey, { tokens, ts });
      const newDaily = daily + 1;
      const currentExpiry = this.strings.get(dailyKey)?.expiresAt;
      this.strings.set(dailyKey, {
        value: String(newDaily),
        expiresAt: newDaily === 1 ? Date.now() + dailyTtlSec * 1000 : (currentExpiry ?? null),
      });
      return Promise.resolve([1, 0, newDaily]);
    }

    throw new Error('FakeLockRateRedis: unrecognised script — did a script change without this fake being updated?');
  }

  asRedis(): Redis {
    return this as unknown as Redis;
  }
}

describe('RedisSendRateLimiter (architecture §18)', () => {
  let redis: FakeLockRateRedis;

  beforeEach(() => {
    redis = new FakeLockRateRedis();
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it('allows sends up to the burst, then refuses', async () => {
    const limiter = new RedisSendRateLimiter(redis.asRedis(), {
      sustainedPerMinute: 20,
      burst: 3,
      dailyCap: 1000,
    });

    const first = await limiter.check('inst-1');
    const second = await limiter.check('inst-1');
    const third = await limiter.check('inst-1');
    const fourth = await limiter.check('inst-1');

    expect([first, second, third].every((d) => d.allowed)).toBe(true);
    expect(fourth.allowed).toBe(false);
    expect(fourth.reason).toBe('burst');
    expect(fourth.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills continuously — a token comes back before a full minute passes', async () => {
    const limiter = new RedisSendRateLimiter(redis.asRedis(), {
      sustainedPerMinute: 60, // 1 token/sec, easy to reason about
      burst: 1,
      dailyCap: 1000,
    });

    expect((await limiter.check('inst-1')).allowed).toBe(true);
    expect((await limiter.check('inst-1')).allowed).toBe(false);

    vi.setSystemTime(1_000); // exactly one refill interval later
    expect((await limiter.check('inst-1')).allowed).toBe(true);
  });

  it('two different instances have independent buckets', async () => {
    const limiter = new RedisSendRateLimiter(redis.asRedis(), {
      sustainedPerMinute: 20,
      burst: 1,
      dailyCap: 1000,
    });

    expect((await limiter.check('inst-A')).allowed).toBe(true);
    expect((await limiter.check('inst-A')).allowed).toBe(false);
    // B has never sent — its own bucket is still full.
    expect((await limiter.check('inst-B')).allowed).toBe(true);
  });

  it('the daily cap refuses even with tokens still in the bucket', async () => {
    const limiter = new RedisSendRateLimiter(redis.asRedis(), {
      sustainedPerMinute: 6_000, // refills fast so the bucket is never the binding constraint
      burst: 5,
      dailyCap: 2,
    });

    expect((await limiter.check('inst-1')).allowed).toBe(true);
    vi.setSystemTime(500);
    expect((await limiter.check('inst-1')).allowed).toBe(true);
    vi.setSystemTime(1_000);
    const third = await limiter.check('inst-1');
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('daily_cap');
  });
});

describe('RedisInstanceLock (architecture §11.3)', () => {
  let redis: FakeLockRateRedis;

  beforeEach(() => {
    redis = new FakeLockRateRedis();
  });

  it('the first acquirer gets the lock; a second process is refused', async () => {
    const processA = new RedisInstanceLock(redis.asRedis(), 30, 'process-A');
    const processB = new RedisInstanceLock(redis.asRedis(), 30, 'process-B');

    expect(await processA.acquire('inst-1')).toBe(true);
    expect(await processB.acquire('inst-1')).toBe(false);
  });

  it('a process can refresh a lock it holds', async () => {
    const processA = new RedisInstanceLock(redis.asRedis(), 30, 'process-A');
    await processA.acquire('inst-1');

    expect(await processA.refresh('inst-1')).toBe(true);
  });

  it('a process cannot refresh a lock it does not hold', async () => {
    const processA = new RedisInstanceLock(redis.asRedis(), 30, 'process-A');
    const processB = new RedisInstanceLock(redis.asRedis(), 30, 'process-B');
    await processA.acquire('inst-1');

    // B never held it — its refresh must not extend A's lock or claim it.
    expect(await processB.refresh('inst-1')).toBe(false);
    expect(await redis.get(instanceLockKey('inst-1'))).toBe('process-A');
  });

  it('release is a no-op for a lock this process does not hold', async () => {
    const processA = new RedisInstanceLock(redis.asRedis(), 30, 'process-A');
    const processB = new RedisInstanceLock(redis.asRedis(), 30, 'process-B');
    await processA.acquire('inst-1');

    await processB.release('inst-1'); // must not touch A's lock
    expect(await redis.get(instanceLockKey('inst-1'))).toBe('process-A');

    await processA.release('inst-1');
    expect(await redis.get(instanceLockKey('inst-1'))).toBeNull();
  });

  it('once released, a different process can acquire it', async () => {
    const processA = new RedisInstanceLock(redis.asRedis(), 30, 'process-A');
    const processB = new RedisInstanceLock(redis.asRedis(), 30, 'process-B');
    await processA.acquire('inst-1');
    await processA.release('inst-1');

    expect(await processB.acquire('inst-1')).toBe(true);
  });
});
