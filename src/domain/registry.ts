// The instance registry — the service's core, and the only place tenant
// ownership is enforced (architecture §6.2, point 4).
//
// ── The one rule everything here exists to hold ─────────────────────────────
//
// An instance is found by its OWN id, and the presented organization is then
// checked against the one stored on it. The organization is never a lookup key.
// That ordering is what makes a wrong organization unable to select a different
// instance — it can only fail — and it is why `#requireOwned` is a private
// method every public operation must pass through rather than a check each
// route is trusted to remember.

import { randomUUID } from 'node:crypto';
import { GatewayError } from '../errors.js';
import { operationLogger } from '../logger.js';
import type { Manifest } from '../store/manifest.js';
import type { QrReader } from '../store/qr.js';
import type { EventSink } from '../events/outbox.js';
import { EventType } from '../events/schema.js';
import { assertUuid } from '../store/paths.js';
import {
  InstanceState,
  isLive,
  type InstanceRecord,
  type InstanceStatus,
  type WhatsAppConnector,
} from './instance.js';

export interface RegistryDeps {
  manifest: Manifest;
  connector: WhatsAppConnector;
  qr: QrReader;
  outbox: EventSink;
  maxInstances: number;
}

export class InstanceRegistry {
  readonly #manifest: Manifest;
  readonly #connector: WhatsAppConnector;
  readonly #qr: QrReader;
  readonly #outbox: EventSink;
  readonly #maxInstances: number;

  constructor(deps: RegistryDeps) {
    this.#manifest = deps.manifest;
    this.#connector = deps.connector;
    this.#qr = deps.qr;
    this.#outbox = deps.outbox;
    this.#maxInstances = deps.maxInstances;
  }

  /**
   * Find an instance and assert the caller's organization owns it.
   *
   * Returns 404 for both "no such instance" and "not yours" — see
   * GatewayError.notFound and architecture §7.4. A 403 here would confirm the
   * existence of another tenant's instance, and since ids are UUIDs there is
   * nothing to be gained by that disclosure and something real to lose.
   */
  #requireOwned(instanceId: string, organizationId: string): InstanceRecord {
    const id = assertUuid(instanceId, 'instance_id');
    const orgId = assertUuid(organizationId, 'organization_id');

    const record = this.#manifest.get(id);
    if (!record || record.organization_id !== orgId) {
      // Logged so a genuine cross-tenant attempt is visible in an audit, and
      // deliberately at `warn`: in a correct system this never fires, so if it
      // starts firing that is a signal, not noise.
      if (record) {
        operationLogger({
          instance_id: id,
          tenant_id: orgId,
          operation: 'registry.ownership_denied',
        }).warn({ status: 'error' }, 'instance_ownership_mismatch');
      }
      throw GatewayError.notFound(id);
    }
    return record;
  }

  #statusOf(record: InstanceRecord): InstanceStatus {
    const details = this.#connector.detailsOf(record.instance_id);
    return {
      instance_id: record.instance_id,
      organization_id: record.organization_id,
      state: this.#connector.stateOf(record.instance_id),
      created_at: record.created_at,
      ...details,
    };
  }

  /**
   * Create an instance and begin pairing.
   *
   * Both ids come from the BACKEND, which is deliberate: the backend inserts
   * its `whatsapp_instances` row first and hands us the id it recorded. If it
   * generated the id here instead, a create whose response was lost in flight
   * would leave the backend with no id for a live instance — an orphaned
   * socket nothing can address. Caller-supplied ids make the call retryable.
   *
   * Idempotent: creating an instance that already exists returns its current
   * status rather than a conflict, so that retry is safe.
   */
  async create(instanceId: string, organizationId: string): Promise<InstanceStatus> {
    const id = assertUuid(instanceId, 'instance_id');
    const orgId = assertUuid(organizationId, 'organization_id');

    const existing = this.#manifest.get(id);
    if (existing) {
      // Same id, different owner. Not a create-that-already-succeeded — this is
      // either a backend bug or an attempt to adopt another tenant's instance,
      // and neither may be answered with that instance's status.
      if (existing.organization_id !== orgId) throw GatewayError.notFound(id);
      return this.#statusOf(existing);
    }

    if (this.#manifest.size >= this.#maxInstances) {
      throw GatewayError.capacityReached(this.#maxInstances);
    }

    const record: InstanceRecord = {
      instance_id: id,
      organization_id: orgId,
      created_at: new Date().toISOString(),
    };

    // Manifest first, socket second. A manifest entry with no socket is
    // recoverable — the next restart or reconnect starts it. A socket with no
    // manifest entry is not: nothing would know to stop it, and nothing would
    // restore it after a restart.
    await this.#manifest.upsert(record);

    const log = operationLogger({
      instance_id: id,
      tenant_id: orgId,
      operation: 'registry.create',
    });

    await this.#outbox.enqueue(EventType.INSTANCE_CREATED, {
      instanceId: id,
      tenantId: orgId,
      payload: {},
    });

    try {
      await this.#connector.start(id);
    } catch (err) {
      // The record stays. The instance is simply in a non-live state, which
      // `reconnect` can retry — rolling the manifest back here would discard a
      // registration the backend already believes in.
      log.error({ err: (err as Error).message, status: 'error' }, 'instance_start_failed');
    }

    log.info({ status: 'ok' }, 'instance_created');
    return this.#statusOf(record);
  }

  get(instanceId: string, organizationId: string): InstanceStatus {
    return this.#statusOf(this.#requireOwned(instanceId, organizationId));
  }

  /**
   * Every instance, optionally narrowed to one organization.
   *
   * The filter is applied by the manifest, not by the caller, so an omitted
   * filter cannot accidentally return the whole platform to a tenant-scoped
   * request. The route makes `organization_id` mandatory for exactly that
   * reason; this signature keeps the unfiltered form available for the
   * boot-time restore, which legitimately needs all of them.
   */
  list(organizationId?: string): InstanceStatus[] {
    return this.#manifest.list(organizationId).map((record) => this.#statusOf(record));
  }

  async qr(instanceId: string, organizationId: string): Promise<{ qr: string; expires_in_ms: number }> {
    const record = this.#requireOwned(instanceId, organizationId);
    const state = this.#connector.stateOf(record.instance_id);

    // A connected instance has no QR and never will. Answering 410 ("expired")
    // would tell the UI to retry pairing something already paired.
    if (state === InstanceState.CONNECTED) {
      throw GatewayError.conflict('Instance is already connected.', { state });
    }

    const stored = await this.#qr.get(record.instance_id);
    if (!stored) throw GatewayError.qrExpired();
    return stored;
  }

  /**
   * Restart pairing or reconnection.
   *
   * Also the recovery path out of `failed` and `qr_timeout`, which is why it
   * resets rather than resumes: those states mean the connector stopped trying
   * on its own, and an operator asking again is asking for a fresh start.
   */
  async reconnect(instanceId: string, organizationId: string): Promise<InstanceStatus> {
    const record = this.#requireOwned(instanceId, organizationId);
    const state = this.#connector.stateOf(record.instance_id);

    if (state === InstanceState.CONNECTED) {
      throw GatewayError.conflict('Instance is already connected.', { state });
    }

    await this.#connector.start(record.instance_id);

    operationLogger({
      instance_id: record.instance_id,
      tenant_id: record.organization_id,
      operation: 'registry.reconnect',
    }).info({ status: 'ok', previous_state: state }, 'instance_reconnect_requested');

    return this.#statusOf(record);
  }

  /**
   * Close the socket but KEEP credentials.
   *
   * The distinction from `remove` is the whole point: this is "pause", and
   * reconnecting after it must not make the studio scan a QR again. Only
   * `remove` destroys credentials.
   */
  async disconnect(instanceId: string, organizationId: string): Promise<InstanceStatus> {
    const record = this.#requireOwned(instanceId, organizationId);

    await this.#connector.stop(record.instance_id);
    await this.#qr.clear(record.instance_id);

    await this.#outbox.enqueue(EventType.INSTANCE_DISCONNECTED, {
      instanceId: record.instance_id,
      tenantId: record.organization_id,
      payload: { reason_code: 'operator_disconnect', will_retry: false, next_retry_at: null },
    });

    operationLogger({
      instance_id: record.instance_id,
      tenant_id: record.organization_id,
      operation: 'registry.disconnect',
    }).info({ status: 'ok' }, 'instance_disconnected');

    return this.#statusOf(record);
  }

  /** Log out of WhatsApp, destroy credentials, and forget the instance. */
  async remove(instanceId: string, organizationId: string): Promise<void> {
    const record = this.#requireOwned(instanceId, organizationId);

    await this.#connector.logout(record.instance_id);
    await this.#qr.clear(record.instance_id);

    // The event is enqueued BEFORE the manifest entry goes, because the
    // envelope needs the tenant id and the record is the only thing that
    // carries it. Enqueue is local to Redis and does not wait on the backend,
    // so this costs nothing.
    await this.#outbox.enqueue(EventType.INSTANCE_DELETED, {
      instanceId: record.instance_id,
      tenantId: record.organization_id,
      payload: {},
    });

    await this.#manifest.remove(record.instance_id);

    operationLogger({
      instance_id: record.instance_id,
      tenant_id: record.organization_id,
      operation: 'registry.remove',
    }).info({ status: 'ok' }, 'instance_removed');
  }

  /**
   * Restore every known instance on boot (architecture §4.3).
   *
   * One failure must not abort the sweep — an instance with corrupted
   * credentials would otherwise stop every healthy studio from reconnecting
   * after a restart. Each is attempted independently and failures are counted.
   */
  async restoreAll(): Promise<{ attempted: number; restored: number; failed: number }> {
    const records = this.#manifest.list();
    let restored = 0;
    let failed = 0;

    for (const record of records) {
      const log = operationLogger({
        instance_id: record.instance_id,
        tenant_id: record.organization_id,
        operation: 'registry.restore',
      });
      try {
        const state = await this.#connector.start(record.instance_id);
        restored += 1;
        log.info({ status: 'ok', state }, 'instance_restored');
      } catch (err) {
        failed += 1;
        log.error({ status: 'error', err: (err as Error).message }, 'instance_restore_failed');
      }
    }

    return { attempted: records.length, restored, failed };
  }

  /** Counts for /metrics and readiness. */
  summary(): { total: number; live: number; capacity: number } {
    const all = this.#manifest.list();
    return {
      total: all.length,
      live: all.filter((r) => isLive(this.#connector.stateOf(r.instance_id))).length,
      capacity: this.#maxInstances,
    };
  }

  /** A fresh id for a caller that has none. Not used by the ERP path. */
  static newInstanceId(): string {
    return randomUUID();
  }
}
