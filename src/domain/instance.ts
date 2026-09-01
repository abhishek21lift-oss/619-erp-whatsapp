// The instance domain: states, records, and the port Phase 3 plugs Baileys into.

/**
 * Connection states (architecture §4.1).
 *
 * These are the values the ERP's `whatsapp_instances.status` CHECK constraint
 * accepts, character for character. Adding one here without the matching
 * migration means the backend rejects an event it was told to expect.
 */
export const InstanceState = {
  /** Created, but no pairing has ever succeeded. */
  NEVER_CONNECTED: 'never_connected',
  /** A socket is open and a QR is being offered. */
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  /** Deliberately closed by an operator. Credentials are KEPT. */
  DISCONNECTED: 'disconnected',
  RECONNECTING: 'reconnecting',
  /** WhatsApp invalidated the device. Credentials destroyed; a new QR is required. */
  LOGGED_OUT: 'logged_out',
  /** Nobody scanned the QR within WA_QR_MAX_ROUNDS. */
  QR_TIMEOUT: 'qr_timeout',
  /** Reconnection gave up. Not terminal — `reconnect` resets the counter. */
  FAILED: 'failed',
} as const;

export type InstanceStateValue = (typeof InstanceState)[keyof typeof InstanceState];

export const ALL_INSTANCE_STATES: readonly InstanceStateValue[] = Object.values(InstanceState);

/**
 * States in which a socket is (or should be) held open.
 *
 * Used to decide whether a restart needs to restore this instance, and whether
 * `connect` on it is a no-op or a conflict.
 */
export function isLive(state: InstanceStateValue): boolean {
  return (
    state === InstanceState.CONNECTING ||
    state === InstanceState.CONNECTED ||
    state === InstanceState.RECONNECTING
  );
}

/**
 * States from which pairing requires a fresh QR scan.
 *
 * `disconnected` is deliberately NOT here: it means "paused, credentials
 * intact", and reconnecting from it must not make a studio rescan.
 */
export function requiresQr(state: InstanceStateValue): boolean {
  return (
    state === InstanceState.NEVER_CONNECTED ||
    state === InstanceState.LOGGED_OUT ||
    state === InstanceState.QR_TIMEOUT
  );
}

/**
 * The durable half of an instance: who owns it and when it was created.
 *
 * This is what the manifest holds (architecture §4.3) and it is deliberately
 * tiny — it is the ONLY thing that must survive a process restart in order to
 * restore every session, so keeping it small keeps restore simple.
 *
 * Note what is absent: no state, no phone number, no timestamps. Those are
 * derived on boot from the session directory and the live socket, and the
 * ERP's `whatsapp_instances` row is the business record for them. Persisting
 * a second copy here would create two sources of truth that drift.
 */
export interface InstanceRecord {
  instance_id: string;
  organization_id: string;
  created_at: string;
}

/** The live view of an instance: the record plus everything runtime knows. */
export interface InstanceStatus {
  instance_id: string;
  organization_id: string;
  state: InstanceStateValue;
  /** Present only once connected, and only when WhatsApp reported it. */
  phone_e164: string | null;
  connected_at: string | null;
  disconnected_at: string | null;
  /** The last Baileys disconnect reason, for support. Never a raw error object. */
  last_error_code: string | null;
  created_at: string;
}

/**
 * The port Phase 3 implements with Baileys.
 *
 * Defined now, and the service built against it, so that Phase 3 is a new
 * implementation of a tested interface rather than surgery on a working
 * service. It also means the registry, the routes and the ownership checks are
 * unit-testable forever without a WhatsApp connection — which matters, because
 * a real connection cannot be part of an automated test suite.
 *
 * Implementations own the socket and its lifecycle. They do NOT own the
 * registry, the manifest, or event emission; those stay above this line so
 * that a second connector (a fake, a future provider) cannot diverge on them.
 */
export interface WhatsAppConnector {
  /**
   * Open a socket for this instance, restoring saved credentials if present.
   * Returns the state the instance is now in — normally `connecting`, or
   * `connected` when restoration succeeded without a QR.
   */
  start(instanceId: string): Promise<InstanceStateValue>;

  /** Close the socket, KEEPING credentials. Idempotent. */
  stop(instanceId: string): Promise<void>;

  /** Close the socket and DESTROY credentials. Idempotent. */
  logout(instanceId: string): Promise<void>;

  /** Current state, or `never_connected` when this connector has no socket. */
  stateOf(instanceId: string): InstanceStateValue;

  /** Runtime details for the status endpoint. */
  detailsOf(instanceId: string): {
    phone_e164: string | null;
    connected_at: string | null;
    disconnected_at: string | null;
    last_error_code: string | null;
  };

  /** Release every socket cleanly. Called on SIGTERM. */
  shutdown(): Promise<void>;
}
