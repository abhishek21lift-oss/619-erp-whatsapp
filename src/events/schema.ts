// The event contract with the ERP (architecture §8, Appendix B).
//
// ── Baileys' own events are deliberately not this contract ──────────────────
//
// They change between Baileys versions and carry protocol detail the ERP has
// no business knowing. Everything crossing to the backend is normalised into
// the envelope below, so a Baileys upgrade is a change inside this service
// rather than a change to a published contract.

export const SCHEMA_VERSION = 1 as const;

export const EventType = {
  INSTANCE_CREATED: 'whatsapp.instance.created',
  INSTANCE_QR: 'whatsapp.instance.qr',
  INSTANCE_CONNECTING: 'whatsapp.instance.connecting',
  INSTANCE_CONNECTED: 'whatsapp.instance.connected',
  INSTANCE_DISCONNECTED: 'whatsapp.instance.disconnected',
  INSTANCE_LOGGED_OUT: 'whatsapp.instance.logged_out',
  INSTANCE_DELETED: 'whatsapp.instance.deleted',
} as const;

export type EventTypeValue = (typeof EventType)[keyof typeof EventType];

export interface GatewayEvent<P = Record<string, unknown>> {
  schema_version: typeof SCHEMA_VERSION;
  /** UUID v4. The backend's idempotency key — see architecture §7.3. */
  event_id: string;
  event_type: EventTypeValue;
  instance_id: string;
  /** The ERP's organization_id. */
  tenant_id: string;
  occurred_at: string;
  payload: P;
}

/**
 * Payload shapes, per type.
 *
 * `whatsapp.instance.qr` carries NO QR string — only the fact that one is
 * available and when it expires. A QR is a pairing credential: anyone who
 * scans it links a device to that studio's account. Putting it in an event
 * would copy it into the backend's request logs, the idempotency ledger and
 * any future event archive — several durable places it has no business being.
 * The string is fetched over the authenticated `GET /v1/instances/:id/qr`.
 * Architecture §8.3.
 */
export interface EventPayloads {
  [EventType.INSTANCE_CREATED]: Record<string, never>;
  [EventType.INSTANCE_QR]: { expires_at: string; round: number };
  [EventType.INSTANCE_CONNECTING]: { attempt: number };
  [EventType.INSTANCE_CONNECTED]: {
    phone_e164: string | null;
    connected_at: string;
  };
  [EventType.INSTANCE_DISCONNECTED]: {
    reason_code: string | null;
    will_retry: boolean;
    next_retry_at: string | null;
  };
  [EventType.INSTANCE_LOGGED_OUT]: { reason_code: string | null };
  [EventType.INSTANCE_DELETED]: Record<string, never>;
}

export function buildEvent<T extends EventTypeValue>(
  eventType: T,
  args: {
    eventId: string;
    instanceId: string;
    tenantId: string;
    payload: T extends keyof EventPayloads ? EventPayloads[T] : Record<string, unknown>;
    occurredAt?: Date;
  },
): GatewayEvent {
  return {
    schema_version: SCHEMA_VERSION,
    event_id: args.eventId,
    event_type: eventType,
    instance_id: args.instanceId,
    tenant_id: args.tenantId,
    occurred_at: (args.occurredAt ?? new Date()).toISOString(),
    payload: args.payload as Record<string, unknown>,
  };
}
