// src/release.ts
//
// Which build is this, exactly — the gateway's half of the cross-repo release
// contract.
//
// ── What the three services could answer before ────────────────────────────
//
// Nothing, in any of them. The backend returned a hardcoded '3.0.0' that no
// deploy had ever changed; this service returned package.json's version, which
// changes roughly never; the frontend reported nothing at all. So two ordinary
// questions had no answer on a live system:
//
//   · "is the fix deployed?" — only answerable by triggering the bug again;
//   · "do these three agree?" — the backend, the frontend and this gateway
//     deploy from three repositories on three workflows, and nothing anywhere
//     recorded which commit of each was live at once. A rollback could
//     therefore restore a guess per service, never a known-compatible SET.
//
// ── The contract number, and why it is not the version ─────────────────────
//
// `version` is the human release number and changes for any reason. `contract`
// changes only when the HTTP surface BETWEEN services changes in a way that
// requires the other side to move with it — a removed or renamed field, a
// narrowed type, a newly required request field, a changed error code.
//
// The backend compares against this number, not against a semver string it
// would then have to encode compatibility rules for. See COMPATIBILITY.md at
// the repository root for the rule and the current matrix.
//
// ── `unknown` is an answer ─────────────────────────────────────────────────
//
// A production image has no .git directory, so the sha arrives as a build ARG.
// A locally built image genuinely has no commit, and reporting "unknown" is
// honest; inventing one — a timestamp, the version relabelled — would put a
// value that looks authoritative next to ones that are.

import os from 'node:os';
import { createRequire } from 'node:module';

const requireCjs = createRequire(import.meta.url);
const pkg = requireCjs('../package.json') as { version?: string };

/**
 * The wire contract this gateway speaks with the ERP backend.
 *
 * 1 — POST /v1/instances/:id/messages { to, text, client_message_id },
 *     X-Gateway-Key auth, the ErrorCode set in errors.ts, and the signed
 *     webhook envelope in events/schema.ts.
 *
 * Bump ONLY for a change that breaks a backend running the previous release.
 */
export const GATEWAY_CONTRACT_VERSION = 1;

/**
 * The lowest backend contract this gateway can serve.
 *
 * Stated rather than assumed, so a mismatch is a refusal with a number in it
 * instead of a 404 on a field nobody expected to be missing.
 */
export const MIN_BACKEND_CONTRACT = 1;

function normalizeSha(raw: string | undefined): string {
  const sha = String(raw ?? '').trim();
  // `$` catches an unsubstituted build arg — "${GIT_SHA}" is the single most
  // likely wrong value to arrive here and would otherwise be reported as a commit.
  if (!sha || sha.includes('$') || !/^[0-9a-f]{7,40}$/i.test(sha)) return 'unknown';
  return sha.toLowerCase();
}

export interface ReleaseInfo {
  service: 'whatsapp-gateway';
  version: string;
  sha: string;
  builtAt: string | null;
  contract: number;
  minBackendContract: number;
  node: string;
  instance: string;
}

export function releaseInfo(): ReleaseInfo {
  return {
    service: 'whatsapp-gateway',
    version: pkg.version ?? 'unknown',
    sha: normalizeSha(process.env['GIT_SHA'] ?? process.env['SOURCE_COMMIT']),
    // From the build, not process start: a restart would otherwise make a
    // month-old image look like it was deployed four minutes ago.
    builtAt: process.env['BUILD_TIME'] ?? null,
    contract: GATEWAY_CONTRACT_VERSION,
    minBackendContract: MIN_BACKEND_CONTRACT,
    node: process.version,
    instance: os.hostname(),
  };
}

export { normalizeSha };
