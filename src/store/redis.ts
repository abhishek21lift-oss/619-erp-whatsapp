// Redis client (architecture §11).
//
// ── Redis is a HARD dependency here, unlike in the ERP ──────────────────────
//
// The ERP degrades gracefully when Redis is absent: its producers check
// `ensureReady()` and fall back to inline sends. This service cannot do the
// same. QR storage, the event outbox and the single-owner instance lock all
// require Redis, and the lock in particular is what stops two containers from
// corrupting the same session files (§11.3).
//
// So a Redis outage makes this service report NOT READY rather than quietly
// running with a broken lock. Being honestly unavailable is the safer failure.

import { Redis } from 'ioredis';
import { getLogger } from '../logger.js';

/** Every key this service writes is under this prefix. */
export const KEY_PREFIX = 'wa:';

export const keys = {
  qr: (instanceId: string) => `${KEY_PREFIX}qr:${instanceId}`,
  outbox: `${KEY_PREFIX}outbox`,
  outboxProcessing: `${KEY_PREFIX}outbox:processing`,
  /**
   * Delayed retries, scored by when they are due.
   *
   * A ZSET rather than a list because a list has no notion of "not yet". The
   * alternative — sleeping in the delivery loop before retrying — would block
   * every OTHER event behind one failing one, so a single unreachable backend
   * would stall the whole outbox instead of just its own event.
   */
  outboxRetry: `${KEY_PREFIX}outbox:retry`,
  outboxDead: `${KEY_PREFIX}outbox:dead`,
  rateLimit: (instanceId: string) => `${KEY_PREFIX}ratelimit:${instanceId}`,
  lock: (instanceId: string) => `${KEY_PREFIX}lock:${instanceId}`,
} as const;

export interface RedisHandle {
  client: Redis;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

export function createRedis(url: string): RedisHandle {
  const log = getLogger();

  const client = new Redis(url, {
    // Connect on the first command rather than at construction, so importing
    // this module in a test does not open a socket.
    lazyConnect: true,
    // Bounded. ioredis's default retries a command forever once the connection
    // drops, which turns a Redis outage into requests that hang until the
    // client times out instead of failing fast with a 503.
    maxRetriesPerRequest: 3,
    enableOfflineQueue: false,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });

  client.on('error', (err: Error) => {
    // `warn`, not `error`: ioredis emits this on every reconnect attempt, and
    // logging a reconnect at error level makes a 30-second blip look like an
    // outage in every dashboard that counts error lines.
    log.warn({ err: err.message }, 'redis_connection_error');
  });
  client.on('ready', () => log.info('redis_ready'));

  return {
    client,
    async ping() {
      try {
        const pong = await client.ping();
        return pong === 'PONG';
      } catch {
        return false;
      }
    },
    async close() {
      try {
        await client.quit();
      } catch {
        // quit() throws if the connection is already gone; disconnect() is the
        // unconditional teardown and must still run so the process can exit.
        client.disconnect();
      }
    },
  };
}
