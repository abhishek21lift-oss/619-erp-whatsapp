// Disconnect classification (architecture §5.1).
//
// This is the most safety-relevant decision in the connector: retrying the
// wrong close is how a studio's number gets flagged, and not retrying the right
// one is how a studio silently stops receiving messages. Every branch is
// covered here because a live session only ever exercises a few of them.

import { describe, it, expect } from 'vitest';
import { DisconnectReason } from 'baileys';
import { classifyDisconnect, disconnectStatusCode } from '../domain/disconnect.js';
import { InstanceState } from '../domain/instance.js';

describe('classifyDisconnect', () => {
  it('reconnects immediately on restartRequired', () => {
    // Not an optimisation. WhatsApp closes with 515 the instant a QR is
    // scanned, and pairing only completes if we reconnect at once. Treating it
    // as a generic failure means the scan appears to work and the instance then
    // never reaches `connected` — the single most likely way to break pairing.
    const verdict = classifyDisconnect(DisconnectReason.restartRequired);
    expect(verdict.action).toBe('restart_now');
    expect(verdict.state).toBe(InstanceState.CONNECTING);
  });

  it('destroys credentials only for the codes that invalidate them', () => {
    const destroys = [
      DisconnectReason.loggedOut,
      DisconnectReason.badSession,
      DisconnectReason.multideviceMismatch,
    ];
    for (const code of destroys) {
      const verdict = classifyDisconnect(code);
      expect(verdict.action, String(code)).toBe('logout');
      expect(verdict.state, String(code)).toBe(InstanceState.LOGGED_OUT);
    }
  });

  it('never retries loggedOut', () => {
    // Retrying with credentials WhatsApp has explicitly invalidated is exactly
    // the behaviour that gets an account flagged.
    expect(classifyDisconnect(DisconnectReason.loggedOut).action).not.toBe('retry');
    expect(classifyDisconnect(DisconnectReason.loggedOut).action).not.toBe('restart_now');
  });

  it('stands down when the number was paired elsewhere', () => {
    // Reconnecting would fight the other session and flap both, which looks
    // like abuse from WhatsApp's side.
    const verdict = classifyDisconnect(DisconnectReason.connectionReplaced);
    expect(verdict.action).toBe('stop');
    expect(verdict.reasonCode).toBe('connection_replaced');
  });

  it('stops but KEEPS credentials on forbidden', () => {
    // A restriction can be lifted. Destroying the session would force a re-scan
    // that may not even be possible on a restricted account.
    const verdict = classifyDisconnect(DisconnectReason.forbidden);
    expect(verdict.action).toBe('stop');
    expect(verdict.state).toBe(InstanceState.FAILED);
  });

  it('treats transient network codes as retryable', () => {
    const transient = [
      DisconnectReason.connectionClosed,
      DisconnectReason.connectionLost,
      DisconnectReason.timedOut,
      DisconnectReason.unavailableService,
    ];
    for (const code of transient) {
      const verdict = classifyDisconnect(code);
      expect(verdict.action, String(code)).toBe('retry');
      expect(verdict.state, String(code)).toBe(InstanceState.DISCONNECTED);
    }
  });

  it('retries an unrecognised or absent code rather than stranding the instance', () => {
    // WhatsApp can add a code after this was written. Defaulting to `stop`
    // would leave a studio permanently disconnected on a code nobody has seen
    // yet; the raw value is logged so a new one is still visible.
    for (const code of [undefined, 9999, 0]) {
      const verdict = classifyDisconnect(code);
      expect(verdict.action, String(code)).toBe('retry');
      expect(verdict.reasonCode, String(code)).toBe('unknown');
    }
  });

  it('produces a stable reason code for every branch', () => {
    // These strings reach the ERP and are stored in last_error_code, so they
    // are a contract. None may be undefined, empty, or a raw error message.
    const codes = [
      undefined,
      DisconnectReason.restartRequired,
      DisconnectReason.loggedOut,
      DisconnectReason.badSession,
      DisconnectReason.multideviceMismatch,
      DisconnectReason.connectionReplaced,
      DisconnectReason.forbidden,
      DisconnectReason.connectionClosed,
      DisconnectReason.timedOut,
      DisconnectReason.unavailableService,
    ];
    for (const code of codes) {
      const { reasonCode } = classifyDisconnect(code);
      expect(reasonCode, String(code)).toMatch(/^[a-z_]+$/);
    }
  });
});

describe('disconnectStatusCode', () => {
  it('reads the code out of a Boom-shaped error', () => {
    expect(disconnectStatusCode({ output: { statusCode: 401 } })).toBe(401);
  });

  it('returns undefined rather than throwing for anything else', () => {
    // Runs on the error path. A TypeError here would replace a recoverable
    // disconnect with a crash inside the handler meant to recover from it.
    expect(disconnectStatusCode(undefined)).toBeUndefined();
    expect(disconnectStatusCode(null)).toBeUndefined();
    expect(disconnectStatusCode(new Error('plain'))).toBeUndefined();
    expect(disconnectStatusCode('a string')).toBeUndefined();
    expect(disconnectStatusCode({ output: {} })).toBeUndefined();
    expect(disconnectStatusCode({ output: { statusCode: 'nope' } })).toBeUndefined();
  });
});
