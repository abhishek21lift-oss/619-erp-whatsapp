// A tiny in-memory stand-in for the handful of Redis commands the outbox uses.
//
// Deliberately not `ioredis-mock`: the outbox depends on the exact semantics of
// five commands (RPOPLPUSH's atomicity, LREM's match-by-value, ZREM's return
// value as an atomic claim), and those semantics ARE the correctness argument.
// Implementing them here in twenty lines each makes them reviewable, and means
// the tests cannot silently pass because a mock was more forgiving than Redis.
//
// It is not a Redis. It only has to be right about what the outbox does.

import type { Redis } from 'ioredis';

type ZEntry = { member: string; score: number };

export class FakeRedis {
  readonly lists = new Map<string, string[]>();
  readonly zsets = new Map<string, ZEntry[]>();
  /** Set to make the next write throw, for the "outcome not recorded" path. */
  failNextWrite = false;

  #list(key: string): string[] {
    let list = this.lists.get(key);
    if (!list) {
      list = [];
      this.lists.set(key, list);
    }
    return list;
  }

  #zset(key: string): ZEntry[] {
    let z = this.zsets.get(key);
    if (!z) {
      z = [];
      this.zsets.set(key, z);
    }
    return z;
  }

  #maybeFail(): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated redis failure');
    }
  }

  // LPUSH prepends; RPOPLPUSH takes from the tail. Together that is FIFO, which
  // is why the outbox drains oldest-first.
  lpush(key: string, value: string): Promise<number> {
    this.#maybeFail();
    const list = this.#list(key);
    list.unshift(value);
    return Promise.resolve(list.length);
  }

  llen(key: string): Promise<number> {
    return Promise.resolve(this.#list(key).length);
  }

  lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.#list(key);
    const end = stop === -1 ? list.length : stop + 1;
    return Promise.resolve(list.slice(start, end));
  }

  /** Atomic in Redis: the value is never in neither list. */
  rpoplpush(source: string, destination: string): Promise<string | null> {
    const from = this.#list(source);
    const value = from.pop();
    if (value === undefined) return Promise.resolve(null);
    this.#list(destination).unshift(value);
    return Promise.resolve(value);
  }

  /** Matches by VALUE, not by index — which is why `raw` must not be re-encoded. */
  lrem(key: string, count: number, value: string): Promise<number> {
    this.#maybeFail();
    const list = this.#list(key);
    let removed = 0;
    const limit = count === 0 ? Infinity : Math.abs(count);
    for (let i = list.length - 1; i >= 0 && removed < limit; i -= 1) {
      if (list[i] === value) {
        list.splice(i, 1);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  zadd(key: string, score: number, member: string): Promise<number> {
    this.#maybeFail();
    const z = this.#zset(key);
    const existing = z.find((e) => e.member === member);
    if (existing) {
      existing.score = score;
      return Promise.resolve(0);
    }
    z.push({ member, score });
    return Promise.resolve(1);
  }

  zcard(key: string): Promise<number> {
    return Promise.resolve(this.#zset(key).length);
  }

  zrangebyscore(key: string, _min: string, max: number | string, ...rest: unknown[]): Promise<string[]> {
    const ceiling = typeof max === 'number' ? max : Number(max);
    const sorted = [...this.#zset(key)]
      .filter((e) => e.score <= ceiling)
      .sort((a, b) => a.score - b.score)
      .map((e) => e.member);

    // ioredis passes ('LIMIT', offset, count); honour it so the outbox's paging
    // is actually exercised rather than accidentally unbounded.
    const limitIndex = rest.findIndex((a) => String(a).toUpperCase() === 'LIMIT');
    if (limitIndex === -1) return Promise.resolve(sorted);
    const offset = Number(rest[limitIndex + 1] ?? 0);
    const count = Number(rest[limitIndex + 2] ?? sorted.length);
    return Promise.resolve(sorted.slice(offset, offset + count));
  }

  /** Returns 1 when it actually removed — the outbox uses this as its claim. */
  zrem(key: string, member: string): Promise<number> {
    const z = this.#zset(key);
    const index = z.findIndex((e) => e.member === member);
    if (index === -1) return Promise.resolve(0);
    z.splice(index, 1);
    return Promise.resolve(1);
  }

  del(key: string): Promise<number> {
    const had = this.lists.delete(key) || this.zsets.delete(key);
    return Promise.resolve(had ? 1 : 0);
  }

  /** The cast the tests use. Typed here once rather than at every call site. */
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}
