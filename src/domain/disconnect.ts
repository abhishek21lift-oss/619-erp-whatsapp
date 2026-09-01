// Classifying why WhatsApp closed a socket (architecture §5.1).
//
// ── Why this is its own module ──────────────────────────────────────────────
//
// Retrying blindly is the fastest route to a banned number, so this decision is
// the most safety-relevant logic in the connector — and it is the only part of
// it that can be unit-tested without a WhatsApp connection. Separating it means
// every branch below is covered by a test, rather than only the branches a live
// session happens to exercise.

import { DisconnectReason } from 'baileys';
import { InstanceState, type InstanceStateValue } from './instance.js';

export type DisconnectAction =
  /** Reconnect immediately, no backoff. Baileys is asking, not failing. */
  | 'restart_now'
  /** Transient. Eligible for the backoff loop (Phase 5). */
  | 'retry'
  /** Credentials are dead. Destroy them and require a fresh QR. */
  | 'logout'
  /** Do not reconnect. A retry here would make things worse, not better. */
  | 'stop';

export interface DisconnectVerdict {
  action: DisconnectAction;
  state: InstanceStateValue;
  /** Stable, loggable, safe to send to the ERP. Never a raw error message. */
  reasonCode: string;
}

/**
 * Map a WhatsApp close code to what we should do about it.
 *
 * `restart_now` on 515 is not an optimisation — it is required for pairing to
 * work at all. WhatsApp closes the socket with `restartRequired` immediately
 * after a QR is scanned, and the pairing only completes if the client
 * reconnects at once with the credentials it just received. Treating 515 as a
 * generic failure means the QR appears to be scanned successfully and the
 * instance then never reaches `connected`.
 */
export function classifyDisconnect(statusCode: number | undefined): DisconnectVerdict {
  switch (statusCode) {
    case DisconnectReason.restartRequired: // 515
      return {
        action: 'restart_now',
        state: InstanceState.CONNECTING,
        reasonCode: 'restart_required',
      };

    case DisconnectReason.loggedOut: // 401 — the user tapped "Log out"
      return { action: 'logout', state: InstanceState.LOGGED_OUT, reasonCode: 'logged_out' };

    case DisconnectReason.badSession: // 500 — our stored keys are not usable
      return { action: 'logout', state: InstanceState.LOGGED_OUT, reasonCode: 'bad_session' };

    case DisconnectReason.multideviceMismatch: // 411 — the device link is invalid
      return {
        action: 'logout',
        state: InstanceState.LOGGED_OUT,
        reasonCode: 'multidevice_mismatch',
      };

    // The same number was paired somewhere else. Reconnecting would fight the
    // other session and flap both, which looks exactly like abuse from
    // WhatsApp's side. Stand down and let a human decide.
    case DisconnectReason.connectionReplaced: // 440
      return {
        action: 'stop',
        state: InstanceState.DISCONNECTED,
        reasonCode: 'connection_replaced',
      };

    // WhatsApp refused the account. Usually a ban or a restriction, and not
    // something a retry fixes. Credentials are KEPT rather than destroyed: a
    // restriction can be lifted, and throwing away a possibly-recoverable
    // session would force a re-scan that may not even be possible.
    case DisconnectReason.forbidden: // 403
      return { action: 'stop', state: InstanceState.FAILED, reasonCode: 'forbidden' };

    case DisconnectReason.connectionClosed: // 428
      return {
        action: 'retry',
        state: InstanceState.DISCONNECTED,
        reasonCode: 'connection_closed',
      };

    case DisconnectReason.timedOut: // 408, also connectionLost
      return { action: 'retry', state: InstanceState.DISCONNECTED, reasonCode: 'timed_out' };

    case DisconnectReason.unavailableService: // 503
      return {
        action: 'retry',
        state: InstanceState.DISCONNECTED,
        reasonCode: 'unavailable_service',
      };

    default:
      // An unrecognised code, including undefined (a socket that closed with no
      // Boom at all — a dropped TCP connection). Retryable, because the
      // alternative is stranding a studio on a code WhatsApp added after this
      // was written. The raw code is logged separately so a new one is visible.
      return { action: 'retry', state: InstanceState.DISCONNECTED, reasonCode: 'unknown' };
  }
}

/**
 * Pull the numeric close code out of whatever Baileys handed us.
 *
 * `lastDisconnect.error` is typed `Boom | Error | undefined`, and only the Boom
 * shape carries `output.statusCode`. Reading it defensively rather than casting
 * to Boom: this runs on the error path, and a TypeError here would replace a
 * recoverable disconnect with a crash in the handler meant to recover from it.
 */
export function disconnectStatusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: unknown } } | undefined)?.output;
  return typeof output?.statusCode === 'number' ? output.statusCode : undefined;
}
