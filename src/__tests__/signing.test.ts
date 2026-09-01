// Webhook signing and verification (architecture §7.3).
//
// `verifySignature` is the executable specification the backend must match in
// Phase 7. Two hand-written implementations of an HMAC scheme that were never
// compared is a reliable way to ship a receiver that accepts nothing — or,
// far worse, one that accepts anything.

import { describe, it, expect } from 'vitest';
import {
  signBody,
  verifySignature,
  signedPayload,
  TIMESTAMP_TOLERANCE_SEC,
} from '../events/signing.js';

const SECRET = 'a-webhook-secret-long-enough-to-be-real-0123456789';
const BODY = JSON.stringify({ event_id: 'abc', event_type: 'whatsapp.instance.connected' });
const NOW = 1_788_000_000;

function signed(body = BODY, secret = SECRET, at = NOW) {
  const { signature, timestamp } = signBody(body, secret, at);
  return { rawBody: body, signature, timestamp, secret, nowSec: at };
}

describe('signBody', () => {
  it('produces a prefixed hex signature', () => {
    const { signature } = signBody(BODY, SECRET, NOW);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs and different for any change', () => {
    const base = signBody(BODY, SECRET, NOW).signature;

    expect(signBody(BODY, SECRET, NOW).signature).toBe(base);
    expect(signBody(`${BODY} `, SECRET, NOW).signature).not.toBe(base);
    expect(signBody(BODY, `${SECRET}x`, NOW).signature).not.toBe(base);
    expect(signBody(BODY, SECRET, NOW + 1).signature).not.toBe(base);
  });
});

describe('signedPayload', () => {
  it('is unambiguous about where the timestamp ends', () => {
    // Without the separator, ("1", "23") and ("12", "3") would produce
    // identical signed material — one valid signature standing for two
    // different requests.
    expect(signedPayload(1, '23')).not.toBe(signedPayload(12, '3'));
  });
});

describe('verifySignature', () => {
  it('accepts a correctly signed request', () => {
    expect(verifySignature(signed())).toEqual({ ok: true });
  });

  it('rejects a tampered body — the whole point of signing', () => {
    const req = signed();
    const result = verifySignature({ ...req, rawBody: req.rawBody.replace('connected', 'failed') });
    expect(result).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a signature made with a different secret', () => {
    const req = signed(BODY, 'a-completely-different-secret-0123456789abcd');
    expect(verifySignature({ ...req, secret: SECRET })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a replayed request once the window has passed', () => {
    // The reason the timestamp is signed rather than merely sent: a captured
    // `connected` event cannot be re-posted next week.
    const req = signed();
    const later = { ...req, nowSec: NOW + TIMESTAMP_TOLERANCE_SEC + 1 };
    expect(verifySignature(later)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('rejects a request stamped too far in the FUTURE', () => {
    // Rejecting only the past would let an attacker replay a future-stamped
    // request once the clock caught up.
    const req = signed();
    const earlier = { ...req, nowSec: NOW - TIMESTAMP_TOLERANCE_SEC - 1 };
    expect(verifySignature(earlier)).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('accepts a request at the very edge of the window', () => {
    const req = signed();
    expect(verifySignature({ ...req, nowSec: NOW + TIMESTAMP_TOLERANCE_SEC })).toEqual({ ok: true });
    expect(verifySignature({ ...req, nowSec: NOW - TIMESTAMP_TOLERANCE_SEC })).toEqual({ ok: true });
  });

  it('cannot be replayed with a rewritten timestamp', () => {
    // The attack the binding defends against: take a valid old request and
    // change only the timestamp header so it looks fresh. The signature was
    // computed over the OLD timestamp, so it no longer matches.
    const req = signed();
    const forged = { ...req, timestamp: String(NOW + 100), nowSec: NOW + 100 };
    expect(verifySignature(forged)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses missing or malformed headers before reaching the HMAC', () => {
    const req = signed();
    expect(verifySignature({ ...req, signature: undefined })).toEqual({
      ok: false,
      reason: 'missing_signature',
    });
    expect(verifySignature({ ...req, timestamp: undefined })).toEqual({
      ok: false,
      reason: 'missing_timestamp',
    });

    // An empty header is treated as absent, which is what it is.
    expect(verifySignature({ ...req, timestamp: '' })).toEqual({
      ok: false,
      reason: 'missing_timestamp',
    });

    // Present but not an integer. `parseInt` would read "1788000000abc" as a
    // valid 1788000000, which is why the check is a strict regex and not a
    // numeric parse.
    for (const bad of ['abc', '1788000000abc', '-1788000000', '17.88', ' 1788000000', '1e9']) {
      expect(verifySignature({ ...req, timestamp: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: 'malformed_timestamp',
      });
    }
  });

  it('rejects a signature of the wrong length without throwing', () => {
    // Raw timingSafeEqual throws on a length mismatch; hashing both sides first
    // means every comparison runs over 32 bytes regardless.
    const req = signed();
    expect(verifySignature({ ...req, signature: '' })).toEqual({
      ok: false,
      reason: 'missing_signature',
    });

    for (const bad of ['sha256=', 'sha256=deadbeef', 'x'.repeat(500), 'sha512=' + 'a'.repeat(128)]) {
      expect(() => verifySignature({ ...req, signature: bad }), JSON.stringify(bad)).not.toThrow();
      expect(verifySignature({ ...req, signature: bad }), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
    }
  });

  it('round-trips a realistic event body byte for byte', () => {
    // Signing is over the RAW body, so anything that re-serialises the JSON on
    // the way in — a body parser, a proxy — breaks verification. This pins the
    // contract the backend has to honour: verify before parsing.
    const body = JSON.stringify({
      schema_version: 1,
      event_id: '9f1c0000-0000-4000-8000-000000000001',
      event_type: 'whatsapp.instance.connected',
      instance_id: '3b7e0000-0000-4000-8000-000000000002',
      tenant_id: '1a2b0000-0000-4000-8000-000000000003',
      occurred_at: '2026-09-01T10:22:31.004Z',
      payload: { phone_e164: '+919876543210', connected_at: '2026-09-01T10:22:31.004Z' },
    });
    expect(verifySignature(signed(body))).toEqual({ ok: true });

    // A single whitespace change — exactly what a re-serialise would do.
    const reserialised = JSON.stringify(JSON.parse(body), null, 2);
    const req = signed(body);
    expect(verifySignature({ ...req, rawBody: reserialised })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });
});
