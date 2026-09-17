// The Baileys implementation of WhatsAppConnector (architecture §3, §4, §5).
//
// The full connection lifecycle: open a socket, surface the QR, detect a
// successful scan, persist credentials, classify every disconnect, and
// reconnect with bounded exponential backoff.
//
// Three pieces of it live in their own modules, because each is a decision
// worth testing without a WhatsApp connection attached:
//
//   domain/disconnect.ts         — what a close code means and what to do
//   domain/backoff.ts            — how long to wait, and why jittered
//   domain/reconnectScheduler.ts — the per-instance budget and its timer
//   store/sessionRecovery.ts     — corrupted-session detection and quarantine
//
// What remains here is the wiring, and the socket options — several of which
// are non-default for reasons documented at the call site.

import makeWASocket, {
  Browsers,
  fetchLatestBaileysVersion,
  type ConnectionState,
  type WASocket,
  type WAVersion,
} from 'baileys';

import { getLogger, operationLogger } from '../logger.js';
import { sessionDirFor } from '../store/paths.js';
import { useAtomicFileAuthState, type AtomicAuthState } from '../store/authState.js';
import { RecoveryOutcome } from '../store/sessionRecovery.js';
import type { QrWriter } from '../store/qr.js';
import type { EventSink } from '../events/outbox.js';
import { EventType } from '../events/schema.js';
import { InstanceState, type InstanceStateValue, type WhatsAppConnector } from './instance.js';
import { classifyDisconnect, disconnectStatusCode } from './disconnect.js';
import { ReconnectScheduler } from './reconnectScheduler.js';
import type { InstanceLock } from '../store/instanceLock.js';

/** How often the held lock's TTL is renewed while a socket is live (architecture §11.3). */
const LOCK_REFRESH_INTERVAL_MS = 10_000;

export interface BaileysConnectorDeps {
  sessionRoot: string;
  qr: QrWriter;
  outbox: EventSink;
  /** Single-owner instance lock (architecture §11.3) — see store/instanceLock.ts. */
  lock: InstanceLock;
  /**
   * Who owns this instance. Backed by the manifest, so the connector never
   * holds a second copy of ownership that could drift from the registry's.
   * Returns undefined for an instance that has been removed mid-flight, in
   * which case no event is emitted — an event with no tenant is unroutable.
   */
  resolveTenant: (instanceId: string) => string | undefined;
  /** Where an unrecoverable session directory is preserved (§13.2). */
  quarantineRoot: string;
  qrTtlSec: number;
  qrMaxRounds: number;
  /** Session-wide QR budget — see config.WA_PAIRING_MAX_ROUNDS. */
  pairingMaxRounds: number;
  /** See config.WA_CONNECT_TIMEOUT_MS — why this exists is documented there. */
  connectTimeoutMs: number;
  /** Backoff parameters — architecture §5.2. */
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  reconnectMaxAttempts: number;
}

interface Runtime {
  sock: WASocket | undefined;
  auth: AtomicAuthState | undefined;
  state: InstanceStateValue;
  /** QR rounds offered on the CURRENT socket. Reset by every #startInner. */
  qrRound: number;
  /**
   * QR rounds offered across this whole pairing session.
   *
   * Deliberately NOT reset by #startInner, because the restart it performs
   * after WhatsApp's 428 is part of the same pairing attempt. Only an operator
   * asking to pair again — start() — clears it. Without that distinction the
   * restart resets its own budget and the gateway offers codes forever.
   */
  pairingRounds: number;
  phoneE164: string | null;
  connectedAt: string | null;
  disconnectedAt: string | null;
  lastErrorCode: string | null;
  /** Set while we are deliberately closing, so the close handler stands down. */
  closing: boolean;
  /** Guards against two concurrent start() calls racing to open a socket. */
  starting: Promise<InstanceStateValue> | undefined;
  /** Fires if the socket produces no signal at all. See #armConnectWatchdog. */
  watchdog: NodeJS.Timeout | undefined;
  /** The reconnection budget and its armed timer. See reconnectScheduler.ts. */
  reconnect: ReconnectScheduler;
  /** Renews the instance lock while a socket is live. See #closeSocket. */
  lockRefreshTimer: NodeJS.Timeout | undefined;
}

function newRuntime(reconnect: ReconnectScheduler): Runtime {
  return {
    sock: undefined,
    auth: undefined,
    state: InstanceState.NEVER_CONNECTED,
    qrRound: 0,
    pairingRounds: 0,
    phoneE164: null,
    connectedAt: null,
    disconnectedAt: null,
    lastErrorCode: null,
    closing: false,
    starting: undefined,
    watchdog: undefined,
    reconnect,
    lockRefreshTimer: undefined,
  };
}

/**
 * Best-effort E.164 for the paired number.
 *
 * In Baileys 7 `user.id` may be a **LID** (`…@lid`) rather than a phone
 * number, which is why `phoneNumber` is preferred and `id` is only parsed when
 * it carries the `@s.whatsapp.net` (PN) suffix. Returning null is a perfectly
 * good answer — the UI shows "Connected" without a number rather than showing
 * a LID, which would look like a corrupted phone number to a studio owner.
 */
export function extractPhoneE164(user: { id?: string; phoneNumber?: string } | undefined): string | null {
  const candidate =
    user?.phoneNumber ?? (user?.id?.includes('@s.whatsapp.net') ? user.id : undefined);
  if (!candidate) return null;

  // Strip the device suffix (`:12`) and the JID domain, then keep digits only.
  const digits = candidate.split('@')[0]?.split(':')[0]?.replace(/\D/g, '') ?? '';
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

/**
 * WhatsApp's own ack levels, from Baileys' WAMessageStatus enum.
 *
 * Written out rather than imported because they are a WIRE contract we only
 * read, and the enum's name has moved between Baileys majors while the numbers
 * have not. Pinning the numbers keeps a Baileys upgrade from silently changing
 * which receipts become which events.
 */
const WA_STATUS_DELIVERED = 3;
const WA_STATUS_READ = 4;
const WA_STATUS_PLAYED = 5;

/**
 * Which delivery event a WhatsApp ack level becomes, if any.
 *
 * Pure and exported so the mapping is testable without a socket — the receipt
 * handler around it needs a live Baileys connection, and the thing most likely
 * to be wrong is this table.
 *
 * Anything below DELIVERY_ACK returns null deliberately. Level 2 is "the
 * server has it", which is the same fact `message.sent` already recorded, and
 * re-reporting it would move a row BACKWARDS in the ERP's status ladder if it
 * arrived after a delivery receipt — WhatsApp does not guarantee these arrive
 * in order.
 */
export function receiptEventFor(
  status: number | null | undefined,
): typeof EventType.MESSAGE_DELIVERED | typeof EventType.MESSAGE_READ | null {
  if (status === WA_STATUS_DELIVERED) return EventType.MESSAGE_DELIVERED;
  if (status === WA_STATUS_READ || status === WA_STATUS_PLAYED) return EventType.MESSAGE_READ;
  return null;
}

/**
 * E.164 digits → the individual-chat JID Baileys addresses.
 *
 * Non-digits are stripped so a stored `+91 99999 99999` and `+919999999999`
 * reach the same person. Group JIDs (`@g.us`) are deliberately unreachable
 * from here: this gateway sends to clients, and a bug that broadcast a
 * studio's automation into a group chat would be unrecoverable.
 */
export function toJid(e164: string): string {
  const digits = String(e164).replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

export class BaileysConnector implements WhatsAppConnector {
  readonly #deps: BaileysConnectorDeps;
  readonly #runtimes = new Map<string, Runtime>();
  #version: WAVersion | undefined;
  #versionResolved = false;

  constructor(deps: BaileysConnectorDeps) {
    this.#deps = deps;
  }

  #runtime(instanceId: string): Runtime {
    let runtime = this.#runtimes.get(instanceId);
    if (!runtime) {
      const scheduler = new ReconnectScheduler({
        baseMs: this.#deps.reconnectBaseMs,
        maxMs: this.#deps.reconnectMaxMs,
        maxAttempts: this.#deps.reconnectMaxAttempts,
        onRetry: () => {
          // #startInner, NOT start(): the public entry point resets the
          // budget, which is right for an operator asking again and wrong
          // here — a self-retry that reset its own budget would loop forever.
          const current = this.#runtimes.get(instanceId);
          if (!current) return;
          void this.#startInner(instanceId, current).catch((err: Error) => {
            operationLogger({
              instance_id: instanceId,
              tenant_id: this.#deps.resolveTenant(instanceId),
              operation: 'connector.reconnect_attempt',
            }).error({ status: 'error', err: err.message }, 'reconnect_attempt_failed');
          });
        },
      });
      runtime = newRuntime(scheduler);
      this.#runtimes.set(instanceId, runtime);
    }
    return runtime;
  }

  /**
   * The WhatsApp Web version to advertise, resolved once per process.
   *
   * `fetchLatestBaileysVersion` never rejects — it returns a bundled fallback
   * with an `error` field when the lookup fails — so this cannot block a boot
   * on network trouble. It is still cached rather than called per socket: with
   * many instances restoring at once, one lookup is the difference between a
   * single request and a burst of identical ones from one IP.
   */
  async #resolveVersion(): Promise<WAVersion | undefined> {
    if (this.#versionResolved) return this.#version;
    this.#versionResolved = true;

    try {
      const result = await fetchLatestBaileysVersion();
      this.#version = result.version;
      getLogger().info(
        { version: result.version, is_latest: result.isLatest, had_error: Boolean(result.error) },
        'whatsapp_version_resolved',
      );
    } catch (err) {
      // Falls through to undefined, which makes makeWASocket use the version
      // bundled with this Baileys build. Staleness is a connection risk, not a
      // correctness one, and refusing to start would be worse.
      getLogger().warn(
        { err: (err as Error).message },
        'whatsapp_version_lookup_failed_using_bundled',
      );
    }
    return this.#version;
  }

  /**
   * Start (or restart) an instance at an operator's request.
   *
   * The PUBLIC entry point, and the difference from the internal retry path is
   * the budget: this resets `reconnectAttempt` to zero. An operator pressing
   * Reconnect — or a fresh process restoring on boot — is asking for a clean
   * slate, and `failed` exists precisely so that ask is meaningful. The
   * automatic retry calls `#startInner` instead, so a self-retry cannot reset
   * its own budget and loop forever.
   */
  async start(instanceId: string): Promise<InstanceStateValue> {
    const runtime = this.#runtime(instanceId);

    // Cancel any armed backoff. Without this an operator's immediate reconnect
    // would race the scheduled one and open two sockets for one instance.
    runtime.reconnect.reset();

    // A fresh pairing budget, for the same reason the reconnect budget is
    // reset here and not in #startInner: somebody is asking to pair again, and
    // `qr_timeout` exists precisely so that ask means something. The internal
    // restart after WhatsApp's 428 goes through #startInner and must NOT land
    // here, or the budget it is bounded by resets on every round.
    runtime.pairingRounds = 0;

    // Two callers can reach this at once — a restore sweep and an API
    // reconnect, say. Without this the second would build a second socket for
    // the same instance and both would write the same creds files.
    if (runtime.starting) return runtime.starting;

    const attempt = this.#startInner(instanceId, runtime).finally(() => {
      runtime.starting = undefined;
    });
    runtime.starting = attempt;
    return attempt;
  }

  async #startInner(instanceId: string, runtime: Runtime): Promise<InstanceStateValue> {
    const tenantId = this.#deps.resolveTenant(instanceId);
    const log = operationLogger({
      instance_id: instanceId,
      tenant_id: tenantId,
      operation: 'connector.start',
    });

    // An already-open socket is left alone. Tearing it down to build an
    // identical one would drop a working WhatsApp connection.
    if (runtime.sock && runtime.state === InstanceState.CONNECTED) {
      return runtime.state;
    }

    await this.#closeSocket(instanceId, runtime, { deliberate: true });

    // Single-owner lock (architecture §11.3): acquired BEFORE the auth state
    // is even read, because creds.json is exactly the file two processes
    // racing here would corrupt. A process that cannot acquire it refuses to
    // start this socket — logged at error, since in a correctly-run MVP
    // (exactly one gateway container) this should never happen, and if it
    // does fire it means two containers are live for the same instance.
    const acquiredLock = await this.#deps.lock.acquire(instanceId);
    if (!acquiredLock) {
      runtime.state = InstanceState.FAILED;
      runtime.lastErrorCode = 'lock_contention';
      log.error(
        { status: 'error' },
        'instance_lock_held_by_another_process — refusing to open a second socket for this instance',
      );
      return runtime.state;
    }
    runtime.lockRefreshTimer = setInterval(() => {
      void this.#deps.lock.refresh(instanceId).then((stillOwned) => {
        if (stillOwned) return;
        // Lost the lock without us releasing it — the TTL expired (a long
        // GC pause, a Redis blip) and another process may now hold it.
        // Continuing to run this socket risks the exact corruption the lock
        // exists to prevent, so it is closed rather than left running
        // unprotected. #closeSocket clears this same timer and best-effort
        // releases the lock, which is a safe no-op since we no longer own it.
        log.error(
          { status: 'error' },
          'instance_lock_lost — closing this socket; another process may now own this instance',
        );
        void this.#closeSocket(instanceId, runtime, { deliberate: true });
      });
    }, LOCK_REFRESH_INTERVAL_MS);
    runtime.lockRefreshTimer.unref();

    const dir = sessionDirFor(this.#deps.sessionRoot, instanceId);
    const auth = await useAtomicFileAuthState(dir, this.#deps.quarantineRoot);
    runtime.auth = auth;
    runtime.qrRound = 0;
    runtime.closing = false;

    // A quarantined session is not a silent event. The studio WAS paired and
    // now is not, and the only way back is scanning a new QR — so the ERP has
    // to be told, or the owner is left looking at a "Connected" card that has
    // quietly stopped being true.
    //
    // Reported as logged_out rather than failed because that is what it means
    // operationally: the credentials are gone and pairing must start over.
    if (auth.outcome === RecoveryOutcome.QUARANTINED) {
      runtime.lastErrorCode = 'session_quarantined';
      log.error(
        { status: 'error', quarantine_path: auth.quarantinePath },
        'session_quarantined — credentials were unrecoverable, a new QR scan is required',
      );
      if (tenantId) {
        await this.#deps.outbox.enqueue(EventType.INSTANCE_LOGGED_OUT, {
          instanceId,
          tenantId,
          payload: { reason_code: 'session_quarantined' },
        });
      }
    } else if (auth.outcome === RecoveryOutcome.RESTORED_FROM_BACKUP) {
      // Recovered, so no event — nothing changed from the ERP's point of view.
      // Loud in the log because it means the primary file was damaged, and a
      // second occurrence on the same instance is a failing volume.
      log.warn({ status: 'ok' }, 'creds_restored_from_backup');
    }

    const version = await this.#resolveVersion();

    const sock = makeWASocket({
      auth: auth.state,
      // A CHILD of the service logger, never a separate one: Baileys logs
      // protocol detail, and a logger without our redaction paths is exactly
      // how Signal key material reaches a log file (§14.2).
      logger: getLogger().child({ component: 'baileys', instance_id: instanceId }),
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu('MY PT STUDIO'),

      // Baileys defaults to true. Left on, the gateway registers as an active
      // online client and WhatsApp stops pushing notifications to the studio
      // owner's own phone — they would silently stop hearing from clients.
      markOnlineOnConnect: false,

      // Also true by default. The MVP reads no history, so a full sync would
      // spend memory and bandwidth on data with nowhere to go (§21.4).
      //
      // NOTE: `shouldSyncHistoryMessage: () => false` is deliberately NOT set,
      // although §21.4 originally called for it. Baileys 7 logs, on every
      // socket where it is:
      //
      //   "DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS
      //    FROM ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILITY AND
      //    SESSION ERRORS"
      //
      // LID mappings are how Baileys 7 resolves a contact's real identity, so
      // suppressing them trades a little bandwidth for sessions that break in
      // ways that are very hard to diagnose. `syncFullHistory: false` already
      // bounds the volume, which was the actual goal.
      syncFullHistory: false,

      qrTimeout: this.#deps.qrTtlSec * 1000,
    });

    runtime.sock = sock;
    runtime.state = InstanceState.CONNECTING;
    this.#armConnectWatchdog(instanceId, runtime);

    sock.ev.on('creds.update', () => {
      void auth.saveCreds().catch((err: Error) => {
        // A failed creds write is how a session silently stops surviving
        // restarts. Atomic writes mean the PREVIOUS creds are still intact, so
        // this is loud but not destructive.
        log.error({ err: err.message, status: 'error' }, 'creds_save_failed');
      });
    });

    sock.ev.on('connection.update', (update) => {
      void this.#onConnectionUpdate(instanceId, runtime, update).catch((err: Error) => {
        log.error({ err: err.message, status: 'error' }, 'connection_update_handler_failed');
      });
    });

    // WhatsApp's own receipts for messages WE sent. This is the only place a
    // real `delivered` can come from — `sent` means WhatsApp accepted it, not
    // that the recipient's phone has it — and the ERP's communication_logs has
    // separate delivered_at and read_at columns waiting for exactly this.
    sock.ev.on('messages.update', (updates) => {
      void this.#onMessageReceipts(instanceId, updates).catch((err: Error) => {
        log.error({ err: err.message, status: 'error' }, 'message_receipt_handler_failed');
      });
    });

    log.info({ status: 'ok', restored: auth.restored }, 'socket_opened');
    return runtime.state;
  }

  /**
   * Fail an instance that gets no response from WhatsApp at all.
   *
   * Found by running this service against a network that blocks WhatsApp: the
   * WebSocket was refused in under 100ms and Baileys emitted NO
   * `connection.update` — not a QR, not a close, not an error. The instance
   * stayed `connecting` indefinitely, so the ERP kept polling a state that
   * would never change and the studio would watch a spinner forever.
   *
   * Cleared by the first sign of life (a QR, or `open`) and by any close, so on
   * a healthy connection it never fires. Unref'd because a pending watchdog
   * must not hold the process open during shutdown.
   */
  #armConnectWatchdog(instanceId: string, runtime: Runtime): void {
    this.#clearWatchdog(runtime);
    runtime.watchdog = setTimeout(() => {
      void this.#onConnectTimeout(instanceId, runtime);
    }, this.#deps.connectTimeoutMs);
    runtime.watchdog.unref();
  }

  #clearWatchdog(runtime: Runtime): void {
    if (runtime.watchdog) {
      clearTimeout(runtime.watchdog);
      runtime.watchdog = undefined;
    }
  }

  async #onConnectTimeout(instanceId: string, runtime: Runtime): Promise<void> {
    runtime.watchdog = undefined;
    // Something arrived while the timer was queued — nothing to do.
    if (runtime.state !== InstanceState.CONNECTING) return;

    const tenantId = this.#deps.resolveTenant(instanceId);
    operationLogger({
      instance_id: instanceId,
      tenant_id: tenantId,
      operation: 'connector.connect_timeout',
    }).error(
      { status: 'error', timeout_ms: this.#deps.connectTimeoutMs },
      'whatsapp_no_response — check egress to WhatsApp from this host',
    );

    runtime.lastErrorCode = 'connect_timeout';
    runtime.disconnectedAt = new Date().toISOString();

    await this.#closeSocket(instanceId, runtime, { deliberate: true });
    await this.#deps.qr.clear(instanceId);

    // Retried through the same backoff loop as any other transient failure.
    // A blocked egress is usually temporary — a firewall change, a DNS blip —
    // and recovering without an operator pressing anything is the whole point
    // of the loop. If it is permanent, the attempt budget still bounds it, and
    // the instance lands in `failed` with this reason code attached.
    const schedule = this.#scheduleReconnect(instanceId, runtime, 'connect_timeout');
    await this.#emitDisconnected(instanceId, tenantId, 'connect_timeout', schedule);
  }

  async #onConnectionUpdate(
    instanceId: string,
    runtime: Runtime,
    update: Partial<ConnectionState>,
  ): Promise<void> {
    const tenantId = this.#deps.resolveTenant(instanceId);
    const log = operationLogger({
      instance_id: instanceId,
      tenant_id: tenantId,
      operation: 'connector.connection_update',
    });

    if (update.qr) {
      await this.#onQr(instanceId, runtime, update.qr, tenantId);
    }

    if (update.connection === 'open') {
      this.#clearWatchdog(runtime);
      runtime.state = InstanceState.CONNECTED;
      runtime.qrRound = 0;
      runtime.pairingRounds = 0;
      // A successful connection is what "recovered" means, so the budget is
      // restored. Otherwise an instance that flapped nine times over a month
      // would give up on its tenth ever disconnect.
      runtime.reconnect.reset();
      runtime.connectedAt = new Date().toISOString();
      runtime.disconnectedAt = null;
      runtime.lastErrorCode = null;
      runtime.phoneE164 = extractPhoneE164(runtime.sock?.user);

      // The QR is consumed the moment pairing succeeds. Leaving it readable
      // would keep a live pairing credential fetchable for up to its TTL.
      await this.#deps.qr.clear(instanceId);

      // Belt and braces: Baileys writes creds via creds.update, but a
      // successful pairing is the one moment where losing them costs a rescan.
      await runtime.auth?.saveCreds().catch(() => undefined);

      log.info(
        { status: 'ok', has_phone: runtime.phoneE164 !== null },
        'whatsapp_connected',
      );

      if (tenantId) {
        await this.#deps.outbox.enqueue(EventType.INSTANCE_CONNECTED, {
          instanceId,
          tenantId,
          payload: {
            phone_e164: runtime.phoneE164,
            connected_at: runtime.connectedAt,
          },
        });
      }
      return;
    }

    if (update.connection === 'close') {
      await this.#onClose(instanceId, runtime, update, tenantId);
    }
  }

  async #onQr(
    instanceId: string,
    runtime: Runtime,
    qr: string,
    tenantId: string | undefined,
  ): Promise<void> {
    // The socket is alive — WhatsApp answered. The watchdog has done its job.
    this.#clearWatchdog(runtime);

    runtime.qrRound += 1;
    runtime.pairingRounds += 1;
    const log = operationLogger({
      instance_id: instanceId,
      tenant_id: tenantId,
      operation: 'connector.qr',
    });

    // An abandoned pairing modal must not leave a socket open indefinitely.
    //
    // Two bounds, because there are two ways to overstay. qrMaxRounds catches
    // one socket that keeps being offered codes; pairingMaxRounds catches a
    // pairing session that keeps opening fresh sockets after each of
    // WhatsApp's 428s — which is the one that actually binds, since WhatsApp
    // closes an unscanned socket at around round four either way.
    if (
      runtime.qrRound > this.#deps.qrMaxRounds ||
      runtime.pairingRounds > this.#deps.pairingMaxRounds
    ) {
      log.info(
        { status: 'ok', rounds: runtime.qrRound, pairing_rounds: runtime.pairingRounds },
        'qr_rounds_exhausted',
      );
      runtime.state = InstanceState.QR_TIMEOUT;
      runtime.lastErrorCode = 'qr_timeout';
      await this.#deps.qr.clear(instanceId);
      await this.#closeSocket(instanceId, runtime, { deliberate: true });
      return;
    }

    runtime.state = InstanceState.CONNECTING;
    await this.#deps.qr.set(instanceId, qr);

    // The QR string is NOT logged and NOT put in the event — it is a pairing
    // credential (§8.3). Only the fact that one exists, and when it expires.
    log.info({ status: 'ok', round: runtime.qrRound }, 'qr_available');

    if (tenantId) {
      await this.#deps.outbox.enqueue(EventType.INSTANCE_QR, {
        instanceId,
        tenantId,
        payload: {
          expires_at: new Date(Date.now() + this.#deps.qrTtlSec * 1000).toISOString(),
          round: runtime.qrRound,
        },
      });
    }
  }

  async #onClose(
    instanceId: string,
    runtime: Runtime,
    update: Partial<ConnectionState>,
    tenantId: string | undefined,
  ): Promise<void> {
    this.#clearWatchdog(runtime);

    // A close we asked for. Its state was already set by whoever asked.
    if (runtime.closing) return;

    const statusCode = disconnectStatusCode(update.lastDisconnect?.error);
    const verdict = classifyDisconnect(statusCode);

    const log = operationLogger({
      instance_id: instanceId,
      tenant_id: tenantId,
      operation: 'connector.close',
    });
    log.info(
      { status: 'ok', status_code: statusCode, reason: verdict.reasonCode, action: verdict.action },
      'whatsapp_disconnected',
    );

    runtime.state = verdict.state;
    runtime.lastErrorCode = verdict.reasonCode;
    runtime.disconnectedAt = new Date().toISOString();
    runtime.sock = undefined;

    if (verdict.action === 'restart_now') {
      // Required for pairing to complete — see classifyDisconnect. No event is
      // emitted: this is one step inside a pairing the ERP already knows is in
      // progress, and reporting it as a disconnect would flicker the UI.
      await this.#deps.qr.clear(instanceId);
      await this.start(instanceId);
      return;
    }

    if (verdict.action === 'logout') {
      // Retrying with credentials WhatsApp has invalidated is how an account
      // gets flagged. Any armed timer from an earlier transient failure dies
      // here too.
      runtime.reconnect.cancel();
      await this.#destroyCredentials(runtime);
      await this.#deps.qr.clear(instanceId);
      runtime.phoneE164 = null;
      runtime.connectedAt = null;

      if (tenantId) {
        await this.#deps.outbox.enqueue(EventType.INSTANCE_LOGGED_OUT, {
          instanceId,
          tenantId,
          payload: { reason_code: verdict.reasonCode },
        });
      }
      return;
    }

    await this.#deps.qr.clear(instanceId);

    // 'stop' means a retry would make things worse, not better — the number was
    // paired elsewhere, or WhatsApp refused the account. Standing down is the
    // action; the state the classifier chose already says so.
    if (verdict.action === 'stop') {
      await this.#emitDisconnected(instanceId, tenantId, verdict.reasonCode, {
        willRetry: false,
        nextRetryAt: null,
      });
      return;
    }

    // ── A pairing QR that expired is not a connection that failed ───────────
    //
    // WhatsApp closes an unscanned pairing socket with 428 after about four QR
    // rounds. classifyDisconnect() can only see the status code, so it calls
    // that 'retry' — correct for a PAIRED instance whose link is flapping, and
    // wrong here in a way that made pairing impossible in production:
    //
    // Every unscanned round burned one reconnect attempt, so the gap between
    // one QR disappearing and the next appearing grew exponentially —
    // 0.5s, 3s, 6s, … up to WA_RECONNECT_MAX_MS (five minutes). Production
    // logs caught it mid-climb: `attempt: 10, delay_ms: 86680`, an 87-second
    // window in which Redis held no QR at all and GET /qr correctly answered
    // 410 to every poll. Ten attempts later came `reconnect_attempts_exhausted`
    // and `failed`, after which no code was ever offered again. On screen that
    // is a pairing dialog stuck on "Waiting for a code…" — which is exactly
    // what a studio reported, on an instance whose backoff had been climbing
    // for hours.
    //
    // WhatsApp Web answers the same 428 by simply showing a fresh code, and so
    // does this: reopen at once, no backoff. `pairingRounds` is what keeps that
    // honest — it survives the restart (see the Runtime field), so the session
    // still stops at WA_PAIRING_MAX_ROUNDS instead of offering codes forever.
    //
    // The test is "was this socket being offered a QR, having never connected"
    // rather than "is connectedAt null": a previously-paired instance restored
    // after a gateway restart also has a null connectedAt, and a 428 on THAT
    // is the flapping case backoff exists for. WhatsApp only emits `qr` when
    // it is not logged in and is waiting for a scan, so qrRound > 0 says
    // pairing with no ambiguity.
    const wasPairing = runtime.qrRound > 0 && runtime.connectedAt === null;

    if (wasPairing) {
      if (runtime.pairingRounds >= this.#deps.pairingMaxRounds) {
        // Budget spent. `qr_timeout` is the honest terminal state and the one
        // registry.reconnect() is documented to recover from — and start()
        // clears pairingRounds, so pressing Connect really does start over.
        runtime.state = InstanceState.QR_TIMEOUT;
        runtime.lastErrorCode = 'qr_timeout';
        log.info(
          { status: 'ok', pairing_rounds: runtime.pairingRounds },
          'pairing_rounds_exhausted',
        );
        await this.#emitDisconnected(instanceId, tenantId, 'qr_timeout', {
          willRetry: false,
          nextRetryAt: null,
        });
        return;
      }

      log.info(
        { status: 'ok', pairing_rounds: runtime.pairingRounds },
        'pairing_qr_session_expired — reopening for a fresh code',
      );
      // #startInner, NOT start(): the public entry point resets the pairing
      // budget, which is right for an operator asking again and wrong here for
      // the same reason the backoff loop avoids it.
      //
      // No event is emitted. This is one step inside a pairing the ERP already
      // knows is in progress, and reporting it as a disconnect would flicker
      // the card behind the dialog between `connecting` and `disconnected`
      // every minute — the same reasoning as the 515 restart above.
      await this.#startInner(instanceId, runtime);
      return;
    }

    // 'retry' → the backoff loop (§5.2).
    const schedule = this.#scheduleReconnect(instanceId, runtime, verdict.reasonCode);
    await this.#emitDisconnected(instanceId, tenantId, verdict.reasonCode, schedule);
  }

  /**
   * Arm the next reconnection attempt, or give up.
   *
   * Returns what the ERP should be told, so `will_retry` and `next_retry_at`
   * describe a timer that actually exists. That honesty is the point: the UI
   * renders these directly, and claiming a retry that was never scheduled
   * leaves a studio watching a countdown to nothing.
   */
  #scheduleReconnect(
    instanceId: string,
    runtime: Runtime,
    reasonCode: string,
  ): { willRetry: boolean; nextRetryAt: string | null } {
    const log = operationLogger({
      instance_id: instanceId,
      tenant_id: this.#deps.resolveTenant(instanceId),
      operation: 'connector.reconnect_schedule',
    });

    const result = runtime.reconnect.schedule();

    if (!result.willRetry) {
      // Not terminal for the CREDENTIALS — `failed` only means the gateway has
      // stopped trying by itself. POST /reconnect resets the budget and the
      // session is still on disk, so recovery does not require a new QR.
      runtime.state = InstanceState.FAILED;
      log.error(
        { status: 'error', attempts: runtime.reconnect.attempt, reason: reasonCode },
        'reconnect_attempts_exhausted',
      );
      return { willRetry: false, nextRetryAt: null };
    }

    runtime.state = InstanceState.RECONNECTING;
    log.info(
      { status: 'ok', attempt: result.attempt, delay_ms: result.delayMs, reason: reasonCode },
      'reconnect_scheduled',
    );
    return { willRetry: true, nextRetryAt: result.nextRetryAt };
  }

  async #emitDisconnected(
    instanceId: string,
    tenantId: string | undefined,
    reasonCode: string,
    schedule: { willRetry: boolean; nextRetryAt: string | null },
  ): Promise<void> {
    if (!tenantId) return;
    await this.#deps.outbox.enqueue(EventType.INSTANCE_DISCONNECTED, {
      instanceId,
      tenantId,
      payload: {
        reason_code: reasonCode,
        will_retry: schedule.willRetry,
        next_retry_at: schedule.nextRetryAt,
      },
    });
  }


  async #destroyCredentials(runtime: Runtime): Promise<void> {
    try {
      await runtime.auth?.clear();
    } catch (err) {
      getLogger().error({ err: (err as Error).message }, 'creds_clear_failed');
    }
    runtime.auth = undefined;
  }

  // ── Outbound messages ──────────────────────────────────────────────────────

  /**
   * Send one text message.
   *
   * Two things this deliberately does not do. It does not retry: the ERP's
   * BullMQ job owns the retry policy, and a second one here would multiply
   * with it into a delivery count nobody can reason about. And it does not
   * check tenant ownership — the registry does that before calling, through
   * `#requireOwned`, which is the one place ownership is decided.
   *
   * `to` arrives as E.164 digits. The JID suffix is applied here so the wire
   * format stays a Baileys detail: the ERP stores phone numbers, not JIDs, and
   * a future provider would want the number rather than this encoding.
   */
  async sendText(
    instanceId: string,
    to: string,
    text: string,
  ): Promise<{ provider_message_id: string }> {
    const runtime = this.#runtime(instanceId);
    const sock = runtime.sock;

    // Both halves matter. A socket can exist while the connection is down —
    // that is precisely the `reconnecting` window — and sending into it
    // resolves with a message id for a message that never left.
    if (!sock || runtime.state !== InstanceState.CONNECTED) {
      throw new Error(`Instance is not connected (state: ${runtime.state}).`);
    }

    const result = await sock.sendMessage(toJid(to), { text });
    const providerMessageId = result?.key?.id;
    if (!providerMessageId) {
      // Baileys resolved without an id. Treating that as success would record
      // a message as sent with nothing to correlate a receipt against, so it
      // is a failure here rather than an untraceable row there.
      throw new Error('WhatsApp accepted the message but returned no message id.');
    }

    operationLogger({
      instance_id: instanceId,
      tenant_id: this.#deps.resolveTenant(instanceId),
      operation: 'connector.send',
    }).info({ status: 'ok', provider_message_id: providerMessageId }, 'message_sent');

    return { provider_message_id: providerMessageId };
  }

  /**
   * Turn WhatsApp's ack levels into delivery events.
   *
   * `fromMe` is the filter that matters: `messages.update` also carries
   * receipts for messages the STUDIO's phone sent by hand and for inbound
   * ones, and emitting those would produce delivery events for message ids the
   * ERP has never heard of — noise its webhook would have to learn to ignore.
   *
   * Statuses below DELIVERY_ACK are dropped rather than mapped. Baileys 2 is
   * "server ack", which is the same fact `sent` already recorded, and emitting
   * it again would move a row backwards in the ERP's status ladder if it
   * arrived after a delivery receipt.
   */
  async #onMessageReceipts(
    instanceId: string,
    updates: { key: { id?: string | null; fromMe?: boolean | null }; update: { status?: number | null } }[],
  ): Promise<void> {
    const tenantId = this.#deps.resolveTenant(instanceId);
    // An instance removed mid-flight. An event with no tenant is unroutable,
    // and the same rule the connection events follow.
    if (!tenantId) return;

    for (const entry of updates) {
      if (!entry.key?.fromMe) continue;
      const providerMessageId = entry.key.id;
      if (!providerMessageId) continue;

      const eventType = receiptEventFor(entry.update?.status);
      if (!eventType) continue;

      const at = new Date().toISOString();
      if (eventType === EventType.MESSAGE_DELIVERED) {
        await this.#deps.outbox.enqueue(eventType, {
          instanceId,
          tenantId,
          payload: { provider_message_id: providerMessageId, delivered_at: at },
        });
      } else {
        await this.#deps.outbox.enqueue(eventType, {
          instanceId,
          tenantId,
          payload: { provider_message_id: providerMessageId, read_at: at },
        });
      }
    }
  }

  /**
   * Close the socket without treating the close as a failure.
   *
   * `sock.end()` fires `connection.update` with `connection: 'close'`, which
   * would otherwise run the classifier over a shutdown we asked for and
   * schedule a reconnect against it. The `closing` flag is what makes a
   * deliberate close distinguishable from WhatsApp hanging up on us.
   */
  async #closeSocket(
    instanceId: string,
    runtime: Runtime,
    options: { deliberate: boolean },
  ): Promise<void> {
    this.#clearWatchdog(runtime);

    if (runtime.lockRefreshTimer) {
      clearInterval(runtime.lockRefreshTimer);
      runtime.lockRefreshTimer = undefined;
    }

    const sock = runtime.sock;
    if (sock) {
      runtime.closing = options.deliberate;
      runtime.sock = undefined;
      try {
        await sock.end(undefined);
      } catch {
        /* already gone; nothing to release */
      } finally {
        runtime.closing = false;
      }
    }

    // Always attempted, not only when a socket existed: no live socket in
    // this process for this instance means this process must not go on
    // holding the lock, whatever state led here. release() is an ownership-
    // checked no-op when this process never held it, so this is safe to call
    // unconditionally rather than tracking a redundant "do we hold it" flag.
    await this.#deps.lock.release(instanceId).catch(() => undefined);
  }

  async stop(instanceId: string): Promise<void> {
    const runtime = this.#runtime(instanceId);
    // An operator disconnect must not be undone thirty seconds later by a
    // backoff timer armed before they pressed the button.
    runtime.reconnect.reset();
    await this.#closeSocket(instanceId, runtime, { deliberate: true });
    runtime.state = InstanceState.DISCONNECTED;
    runtime.disconnectedAt = new Date().toISOString();
    runtime.qrRound = 0;
    // Credentials are KEPT. This is the reversible pause — reconnecting from
    // here must not make the studio scan a new QR (§4.1).
  }

  async logout(instanceId: string): Promise<void> {
    const runtime = this.#runtime(instanceId);
    const log = operationLogger({ instance_id: instanceId, operation: 'connector.logout' });

    // Tell WhatsApp first, while the socket is still usable, so the device
    // disappears from the user's Linked Devices list rather than lingering.
    // Best-effort: an instance that is already offline still has to be able to
    // be deleted, so a failure here must not block the local cleanup below.
    if (runtime.sock) {
      try {
        await runtime.sock.logout();
      } catch (err) {
        log.warn({ err: (err as Error).message, status: 'error' }, 'remote_logout_failed');
      }
    }

    runtime.reconnect.cancel();
    runtime.closing = true;
    await this.#closeSocket(instanceId, runtime, { deliberate: true });
    await this.#destroyCredentials(runtime);

    this.#runtimes.delete(instanceId);
    log.info({ status: 'ok' }, 'instance_logged_out');
  }

  stateOf(instanceId: string): InstanceStateValue {
    return this.#runtimes.get(instanceId)?.state ?? InstanceState.NEVER_CONNECTED;
  }

  detailsOf(instanceId: string): {
    phone_e164: string | null;
    connected_at: string | null;
    disconnected_at: string | null;
    last_error_code: string | null;
  } {
    const runtime = this.#runtimes.get(instanceId);
    return {
      phone_e164: runtime?.phoneE164 ?? null,
      connected_at: runtime?.connectedAt ?? null,
      disconnected_at: runtime?.disconnectedAt ?? null,
      last_error_code: runtime?.lastErrorCode ?? null,
    };
  }

  /**
   * Release every socket cleanly on SIGTERM.
   *
   * Closed in parallel and never allowed to reject: one stuck socket must not
   * stop the other studios' sockets from closing, and a dropped connection
   * without a clean close is one of the patterns that looks like abuse to
   * WhatsApp (§15.2).
   */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#runtimes.entries()].map(([instanceId, runtime]) => {
        // Cancel before closing: a timer that fires mid-shutdown would open a
        // new socket behind the teardown and leave it dangling.
        runtime.reconnect.cancel();
        return this.#closeSocket(instanceId, runtime, { deliberate: true }).catch(() => undefined);
      }),
    );
    this.#runtimes.clear();
  }
}
