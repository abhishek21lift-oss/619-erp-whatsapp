// Single-owner instance lock (architecture §11.3).
//
// Two gateway processes holding sockets for the same instance would fight
// over `creds.json` and corrupt it — Baileys writes that file on every
// credential update, and two writers racing each other can leave it
// unparseable, which is the one failure this whole session-storage layer
// (authState.ts, sessionRecovery.ts) is built to avoid.
//
// "The MVP runs exactly one gateway container" was, before this file
// existed, an assumption nothing checked — `wa:lock:<instance_id>` was
// defined as a Redis key (store/redis.ts) but never read or written
// anywhere. This is what makes it a checked invariant instead: before
// opening a socket, a process must hold this lock; while the socket lives,
// it refreshes the lock so a healthy holder is never displaced by its own
// TTL expiring; a process that cannot acquire it refuses to start that
// socket rather than opening a second one.
//
// ── Why compare-then-act, not a bare SET / DEL ──────────────────────────────
//
// Acquire is a bare `SET NX EX` — the first writer wins, atomically, no
// script needed. Refresh and release are different: without checking that
// the key still holds THIS process's id, a process whose lock already
// expired and was picked up by a new owner could refresh or delete a lock it
// no longer holds, silently sabotaging the process that legitimately holds
// it now. Both run as a single Lua script so the check and the act cannot be
// separated by another client's write landing in between.

import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { KEY_PREFIX } from './redis.js';

/** `SET NX EX 30` per architecture §11.3. Refreshed at LOCK_REFRESH_INTERVAL_MS. */
export const LOCK_TTL_SEC = 30;

export function instanceLockKey(instanceId: string): string {
  return `${KEY_PREFIX}lock:${instanceId}`;
}

export interface InstanceLock {
  /** True if this process now owns the lock for this instance. */
  acquire(instanceId: string): Promise<boolean>;
  /** True if this process still owns it (and the TTL was extended). False means it was lost. */
  refresh(instanceId: string): Promise<boolean>;
  /** No-op if this process does not currently hold it. */
  release(instanceId: string): Promise<void>;
}

/** Exported so a test fake can recognise these exact scripts rather than a real Lua engine. */
export const REFRESH_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

export class RedisInstanceLock implements InstanceLock {
  readonly #redis: Redis;
  readonly #ownerId: string;
  readonly #ttlSec: number;

  /**
   * `ownerId` identifies THIS PROCESS, not this instance — one value shared
   * across every lock this process holds, so a refresh/release can never be
   * fooled by a coincidentally-identical id from another process. Random per
   * process start; there is no reason for it to survive a restart, since a
   * restarted process has no sockets open yet to protect.
   */
  constructor(redis: Redis, ttlSec: number = LOCK_TTL_SEC, ownerId: string = randomUUID()) {
    this.#redis = redis;
    this.#ttlSec = ttlSec;
    this.#ownerId = ownerId;
  }

  async acquire(instanceId: string): Promise<boolean> {
    const result = await this.#redis.set(
      instanceLockKey(instanceId),
      this.#ownerId,
      'EX',
      this.#ttlSec,
      'NX',
    );
    return result === 'OK';
  }

  async refresh(instanceId: string): Promise<boolean> {
    const result = await this.#redis.eval(
      REFRESH_SCRIPT,
      1,
      instanceLockKey(instanceId),
      this.#ownerId,
      this.#ttlSec,
    );
    return result === 1;
  }

  async release(instanceId: string): Promise<void> {
    await this.#redis.eval(RELEASE_SCRIPT, 1, instanceLockKey(instanceId), this.#ownerId);
  }
}

/**
 * A lock that is always free.
 *
 * For deployments and tests with no Redis, the same way AlwaysFreshSendLedger
 * and AlwaysAllowSendRateLimiter are — choosing it is a visible decision, and
 * it is correct for exactly the case those are correct for: a single process,
 * nothing else to contend with.
 */
export class AlwaysAcquiredInstanceLock implements InstanceLock {
  acquire(): Promise<boolean> {
    return Promise.resolve(true);
  }
  refresh(): Promise<boolean> {
    return Promise.resolve(true);
  }
  release(): Promise<void> {
    return Promise.resolve();
  }
}
