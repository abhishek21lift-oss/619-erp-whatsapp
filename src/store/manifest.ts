// The instance manifest (architecture §4.3).
//
// A ~200-byte-per-instance record of "which instances exist and who owns
// them", living on the same volume as the sessions it describes.
//
// ── Why this file is the reason the gateway needs no database ───────────────
//
// Restoring after a restart needs exactly two things: the list of instances,
// and their credentials. The credentials are already files. This is the list.
// Handing the ERP's Postgres to the process with the largest third-party
// dependency tree in the stack, in order to store a list this small, would be
// a poor trade (architecture §12.1).
//
// It is backed up with the sessions, which is correct — restoring sessions
// without the manifest would leave orphaned credential directories that
// nothing knows to start.

import path from 'node:path';
import type { InstanceRecord } from '../domain/instance.js';
import { atomicWriteFile, readJsonIfExists, assertUuid } from './paths.js';

const MANIFEST_VERSION = 1 as const;

interface ManifestFile {
  version: typeof MANIFEST_VERSION;
  instances: InstanceRecord[];
}

/**
 * Serialises async work into a single chain.
 *
 * Two concurrent `upsert` calls would otherwise both read the old manifest,
 * each add their own entry, and the second write would silently drop the
 * first — a lost instance that nothing restores after the next restart.
 *
 * Hand-rolled rather than pulling in a mutex library: it is nine lines, it has
 * no failure mode of its own, and `async-mutex` would arrive as a direct
 * dependency for this one use.
 */
function createSerializer(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // `.then(task, task)` rather than `.then(task)`: a rejected predecessor
    // must not poison the chain and fail every later caller.
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
}

export class Manifest {
  readonly #filePath: string;
  readonly #serialize = createSerializer();
  #cache: Map<string, InstanceRecord> | undefined;

  constructor(filePath: string) {
    this.#filePath = path.resolve(filePath);
  }

  /**
   * Load from disk, or start empty when the file does not exist yet.
   *
   * A missing manifest is the normal first-boot state, not an error. An
   * unparseable one IS an error and is allowed to propagate: silently starting
   * with an empty manifest would leave every existing session directory
   * orphaned and every studio mysteriously disconnected, which is far worse
   * than refusing to boot.
   */
  async load(): Promise<void> {
    const file = await readJsonIfExists<ManifestFile>(this.#filePath);
    const entries = file?.instances ?? [];
    this.#cache = new Map(entries.map((record) => [record.instance_id, record]));
  }

  #entries(): Map<string, InstanceRecord> {
    if (!this.#cache) {
      throw new Error('Manifest.load() must be awaited before use.');
    }
    return this.#cache;
  }

  get(instanceId: string): InstanceRecord | undefined {
    return this.#entries().get(instanceId);
  }

  list(organizationId?: string): InstanceRecord[] {
    const all = [...this.#entries().values()];
    const filtered = organizationId
      ? all.filter((record) => record.organization_id === organizationId)
      : all;
    return filtered.sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  get size(): number {
    return this.#entries().size;
  }

  /**
   * Add an instance, or return the existing record unchanged.
   *
   * Idempotent by design: the backend retries a create when its own insert
   * succeeded but the gateway call timed out, and that retry must not produce
   * a second record or move the ownership of the first.
   */
  async upsert(record: InstanceRecord): Promise<InstanceRecord> {
    assertUuid(record.instance_id, 'instance_id');
    assertUuid(record.organization_id, 'organization_id');

    return this.#serialize(async () => {
      const entries = this.#entries();
      const existing = entries.get(record.instance_id);
      if (existing) return existing;

      entries.set(record.instance_id, record);
      await this.#flush();
      return record;
    });
  }

  async remove(instanceId: string): Promise<boolean> {
    return this.#serialize(async () => {
      const removed = this.#entries().delete(instanceId);
      if (removed) await this.#flush();
      return removed;
    });
  }

  async #flush(): Promise<void> {
    const file: ManifestFile = {
      version: MANIFEST_VERSION,
      instances: [...this.#entries().values()],
    };
    await atomicWriteFile(this.#filePath, `${JSON.stringify(file, null, 2)}\n`);
  }
}
