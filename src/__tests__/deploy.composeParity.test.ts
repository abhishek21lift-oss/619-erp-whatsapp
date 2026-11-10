// Every variable src/config.ts reads must be forwarded by the production Compose
// overlay and documented in .env.example.
//
// ── Why ─────────────────────────────────────────────────────────────────────
//
// Compose only gives a container the variables it names. A knob that exists in
// config.ts, is documented in .env.example, and is set in /opt/myptstudio/.env
// but missing from the `environment:` block is silently replaced by its code
// default — the deploy looks fine and the setting does nothing. That is the
// exact failure the backend documented for ADMIN_DATABASE_URL, and on
// 2026-11-10 this overlay had it for the whole send-pacing and reconnect set:
// an operator could lower WA_SEND_DAILY_CAP and the gateway would still use
// 1000.
//
// The assertion is textual on purpose: Compose interpolation and YAML parsing
// are not what is being tested, and adding a YAML dependency to the gateway for
// one test would be a worse trade than this regex.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(__dirname, '..', '..');
const CONFIG = readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
const COMPOSE = readFileSync(path.join(root, 'deploy', 'compose.whatsapp.yml'), 'utf8');
const ENV_EXAMPLE = readFileSync(path.join(root, '.env.example'), 'utf8');

/** Top-level keys of the config schema, e.g. `  WA_SEND_DAILY_CAP: ...`. */
const schemaKeys = () =>
  [...CONFIG.matchAll(/^\s{2}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]).sort();

/** Keys the overlay forwards into the container, from `KEY:` or `${KEY...}`. */
const composeKeys = new Set(
  [...COMPOSE.matchAll(/\b([A-Z][A-Z0-9_]{2,})(?=:|\})/g)].map((m) => m[1]),
);

describe('the production overlay forwards what the service reads', () => {
  it('finds a real schema', () => {
    // Without this, a moved/renamed config.ts makes both assertions below
    // vacuously true.
    expect(schemaKeys().length).toBeGreaterThan(20);
  });

  it('forwards every config key', () => {
    const missing = schemaKeys().filter((key) => !composeKeys.has(key));
    // Fix: add `KEY: ${KEY:-<same default as config.ts>}` to the overlay's
    // environment block. Do not rename the variable in config.ts.
    expect(missing).toEqual([]);
  });

  it('documents every config key in .env.example', () => {
    const missing = schemaKeys().filter(
      (key) => !new RegExp(`^${key}=`, 'm').test(ENV_EXAMPLE),
    );
    expect(missing).toEqual([]);
  });
});
