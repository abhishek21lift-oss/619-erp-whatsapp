// QR storage (architecture §3.3).
//
// A QR lives in Redis with a TTL and nowhere else. Never on disk, never in an
// event, never in a log line (logger.ts redacts the `qr` path). It is a
// pairing credential with a ~20 second useful life; persisting it would create
// a durable copy of something whose whole security model is that it expires.

import type { Redis } from 'ioredis';
import { keys } from './redis.js';

export interface StoredQr {
  qr: string;
  expires_in_ms: number;
}

/**
 * The read side, as an interface.
 *
 * The registry depends on this rather than on the class below, so its tenant
 * ownership tests can run against a fake and never need a Redis. Those are the
 * tests that matter most and they must not be the ones with an external
 * dependency — the class carries a `#redis` private field, which makes it
 * nominal to TypeScript and unfakeable by a plain object.
 */
export interface QrReader {
  get(instanceId: string): Promise<StoredQr | undefined>;
  clear(instanceId: string): Promise<void>;
}

export class QrStore implements QrReader {
  readonly #redis: Redis;
  readonly #ttlSec: number;

  constructor(redis: Redis, ttlSec: number) {
    this.#redis = redis;
    this.#ttlSec = ttlSec;
  }

  /**
   * Store the current QR, replacing any previous one.
   *
   * Baileys re-emits a fresh QR roughly every 20 seconds and the TTL is 60, so
   * each write overwrites a still-valid predecessor. That overlap is the point:
   * a poll landing between two rounds finds the previous QR rather than a gap,
   * and a QR that is one round stale still scans.
   */
  async set(instanceId: string, qr: string): Promise<void> {
    await this.#redis.set(keys.qr(instanceId), qr, 'EX', this.#ttlSec);
  }

  /**
   * The current QR and its remaining life, or undefined when there is none.
   *
   * Read with a pipeline so the value and its TTL come from one round trip.
   * Fetching them separately can report a TTL for a key that expired between
   * the two calls, which surfaces to the UI as a countdown on a QR that no
   * longer exists.
   */
  async get(instanceId: string): Promise<StoredQr | undefined> {
    const key = keys.qr(instanceId);
    const results = await this.#redis.pipeline().get(key).pttl(key).exec();
    if (!results) return undefined;

    const qr = results[0]?.[1];
    const pttl = results[1]?.[1];
    if (typeof qr !== 'string' || qr.length === 0) return undefined;

    // pttl returns -1 (no expiry) or -2 (no key). Neither should happen for a
    // key we always write with EX, so treat anything non-positive as absent
    // rather than reporting a nonsense countdown.
    const remaining = typeof pttl === 'number' && pttl > 0 ? pttl : 0;
    if (remaining === 0) return undefined;

    return { qr, expires_in_ms: remaining };
  }

  async clear(instanceId: string): Promise<void> {
    await this.#redis.del(keys.qr(instanceId));
  }
}
