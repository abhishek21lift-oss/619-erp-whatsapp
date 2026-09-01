# Testing

What is covered automatically, what is not, and how to run the two checks that
cannot be automated.

> **Read §1 before quoting any number below.** The automated suites do not
> prove this service can pair with WhatsApp, and cannot.

---

## 1. What the automated tests do NOT prove

**No QR has ever been produced from WhatsApp's servers in CI or in the build
environment.** The sandbox this was developed in blocks `web.whatsapp.com` with
a `403` at the egress proxy, verified with a raw WebSocket handshake.

So every green suite below is consistent with a service that cannot pair at all.
The parts they genuinely cover are everything up to the socket: authentication,
tenant isolation, session persistence, event delivery, lifecycle bookkeeping.
The parts they cannot cover are the protocol itself and anything downstream of a
successful pairing.

**A real pairing (§4) is the only evidence that this works.** Until that has been
done on a host with egress, treat the feature as unverified regardless of what
`npm test` says.

---

## 2. Running the suites

| Repo | Command | Needs |
|---|---|---|
| `619-erp-whatsapp` | `npm test` | nothing |
| `619-erp-whatsapp` | `npm run typecheck && npm run lint && npm run build` | nothing |
| `619-erp-backend` | `npm test` | nothing (`db/pool` is mocked) |
| `619-erp-frontend` | `npm test` | nothing |
| `619-erp-frontend` | `npm run typecheck && npm run lint` | nothing |
| `619-erp-frontend` | `NEXT_PUBLIC_API_URL=… npm run build` | the env var, or `rewrites()` throws |

None of the three suites needs Redis, a database, or network access. That is
deliberate: a security test that only runs when an external service happens to
be up is a security test that will one day be quietly skipped.

### Results as of Phase 9

| Suite | Result |
|---|---|
| Gateway | **154 passed**, 14 files |
| Backend | **2696 passed**, 199 suites — plus 1 pre-existing failure, see below |
| Frontend | **1886 passed**, 140 files |

**The one backend failure is pre-existing and unrelated.**
`securityFlags.failClosed.test.js` slices `server.js` between
`const disabled = SECURITY_FLAGS` and the next `const express` (lines 258–303)
and asserts no `process.exit(1)` inside; two later, unrelated exit blocks (the
Redis check and the `PLATFORM_SESSION_ENFORCE` check) now fall in that window.

Confirmed not caused by this work, two ways: the slice contains no WhatsApp
text, and the failure reproduces with every WhatsApp change stashed.

⚠️ **It still matters.** `deploy.yml` gates on `workflow_run` CI success, so
while this test is red the backend cannot auto-deploy. That blocks Phase 13
regardless of anything in this project.

---

## 3. Coverage against the brief

| Required | Where | Notes |
|---|---|---|
| Instance creation | `instanceLifecycle.test.ts` | incl. idempotent re-create and capacity |
| Tenant isolation | `tenantIsolation.test.ts`, backend `whatsapp.routes.tenant.test.js` | every route, both directions |
| Unauthorized access | `gatewayAuth.test.ts` | missing / wrong / prefix-of-correct key |
| QR lifecycle | `instanceLifecycle.test.ts`, frontend `whatsapp-card.test.tsx` | 410 expired, 409 already connected |
| Connection state | `disconnect.test.ts` | every `DisconnectReason` branch |
| Reconnect | `reconnectScheduler.test.ts`, `backoff.test.ts` | budget, reset, jitter, herd spread |
| Disconnect | `instanceLifecycle.test.ts` | kept vs destroyed credentials |
| Session persistence | `authState.test.ts`, `sessionRecovery.test.ts` | round-trip, backup, quarantine |
| Malformed requests | `instanceLifecycle.test.ts`, `signing.test.ts` | traversal, over-long ids, bad JSON |
| Webhook authentication | `signing.test.ts`, backend `whatsapp.webhook.test.js` | signed both sides, independently |
| Duplicate events | backend `whatsapp.webhook.test.js` | ledger claim is atomic |
| **Graceful shutdown** | `shutdown.test.ts` | **added in Phase 9** — see §5 |

### The signing contract is tested from both ends

`src/events/signing.ts` exports `verifySignature`, which the gateway never
calls. It exists as the executable specification the backend must match, and
`deliverer.test.ts` feeds the worker's *actual* outbound request through it.

The backend implements the same scheme independently in
`routes/whatsapp-webhook.js`. Two hand-written HMAC implementations that were
never compared is a reliable way to ship a receiver that accepts nothing — or
worse, one that accepts anything.

---

## 4. Real-phone QR pairing (MANUAL — Phase 10)

> **Use a number the studio is willing to lose.** This links a real WhatsApp
> account through an unofficial client. Meta can ban the number permanently,
> without warning and with no appeal. Do **not** use the studio's live number
> for the first run.

### 4.1 Prerequisites

- A host with **outbound access to `web.whatsapp.com`** — verify first:
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' https://web.whatsapp.com/
  ```
  Anything other than a 2xx/3xx means pairing cannot work, and the connect
  watchdog will report `connect_timeout` after `WA_CONNECT_TIMEOUT_MS`.
- Redis reachable.
- A **second phone or a camera** to scan with — the QR is on screen.
- `WA_GATEWAY_KEY` and `WA_WEBHOOK_SECRET` matching between gateway and backend.

### 4.2 Procedure

| # | Step | Expected | Records |
|---|---|---|---|
| 1 | Studio owner opens Settings → Integrations → WhatsApp | Card shows **Not connected** | |
| 2 | Press **Connect WhatsApp** | Risk disclosure appears. **No QR yet** | |
| 3 | Press **I understand — show QR** | QR renders within ~5s | `whatsapp.instance.qr` |
| 4 | Phone → Settings → Linked devices → Link a device → scan | | |
| 5 | Watch the card | Closes itself, shows **🟢 Connected** and a masked number | `whatsapp.instance.connected` |
| 6 | Check `whatsapp_instances` | `status='connected'`, `phone_e164` set, `connected_at` set | |

### 4.3 What to check that a passing scan does not prove

**Restart persistence — the one that matters most.**

```bash
docker compose restart whatsapp
```

- The card must return to **Connected without a new QR**.
- Gateway log: `instances_restored` with `restored` ≥ 1, and `socket_opened`
  with `restored: true`.
- ❌ If a QR appears, session persistence is broken. Stop and investigate
  before widening to any other studio.

**Disconnect is reversible; unlink is not.**

| Action | Expected |
|---|---|
| **Disconnect** then **Reconnect** | returns to Connected, **no QR** |
| **Unlink**, then **Connect** | **requires a new QR**, and the device disappears from the phone's Linked devices list |

**Log out from the phone.** Phone → Linked devices → this device → Log out.
Card must reach **Signed out on the phone** and a `whatsapp.instance.logged_out`
event must arrive. The gateway must **not** retry — retrying with credentials
WhatsApp has invalidated is how an account gets flagged.

**Pull the network.** Block egress for a minute. The card should show
reconnection attempts and recover on its own without anyone pressing anything.

### 4.4 Stop conditions

Abandon the rollout and investigate if any of these occur:

- A QR is required after a plain restart (§4.3).
- The number is restricted or banned at any point.
- `whatsapp.instance.logged_out` is followed by reconnect attempts.
- Two instances ever report the same phone number.

---

## 5. Graceful shutdown

`shutdown.test.ts` covers the deterministic half — that `stop()` waits for an
in-flight delivery, that it is idempotent, that it cannot reject, and that an
armed backoff timer is cancelled rather than left to fire behind a closing
process.

The whole sequence under a real signal needs a built `dist/` and a live Redis,
so it is run by hand:

```bash
npm run build
redis-server --port 6399 --daemonize yes --save '' --appendonly no
# start the gateway, create some instances, then:
kill -TERM <pid>
```

**Verified in Phase 9**, on a process holding 10 instances:

```
exited after 2145ms          (well inside the 25s budget and compose's 30s grace)
gateway_shutting_down  →  gateway_stopped     in order, no timeout, no failure
processing = 0               nothing stranded for the sweeper
retry zset = 9, dead = 1     all 10 events accounted for and durable
manifest   = 10 instances    intact
level 50 (error) lines = 0
```

---

## 6. Per-instance memory — MEASURED, but NOT sufficient

§21.3 of the architecture assigns the `WA_MAX_INSTANCES` measurement to this
phase. It was taken, and it **does not license setting the value**.

Measured RSS of the gateway process, Node 20, `baileys@7.0.0-rc14`:

| Instances | RSS | Marginal |
|---|---|---|
| 0 (baseline) | 145 MB | — |
| 1 | 165 MB | +20 MB — one-time Baileys/WASM initialisation |
| 5 | 178 MB | ~3.1 MB each |
| 10 | 182 MB | ~1 MB each |

**Why this is a floor and not the operating figure:** none of those instances
ever connected — egress to WhatsApp is blocked here (§1). A *live* session
additionally holds Signal session state, app-state sync keys, the LID mapping
store and message caches, and those are where the memory actually goes.

**`WA_MAX_INSTANCES` therefore stays at its untested default of 50**, and the
measurement is repeated in Phase 10 against connected sessions before that
number is trusted. Setting a production capacity limit from a number taken on a
host that cannot reach WhatsApp would be exactly the false confidence §1 warns
about.

---

## 7. Known gaps

| Gap | Why it is not covered | When |
|---|---|---|
| Real WhatsApp pairing | No egress in CI or the build environment | Phase 10, §4 |
| Per-instance memory of a **connected** session | Same | Phase 10, §6 |
| The connect watchdog | Would have to either reach WhatsApp or fail to, and which one CI does is not something this repo controls. A test that passes for the wrong reason is worse than none | Verified by hand in Phase 3 against a blocked network |
| A built Docker image | The build environment cannot reach Docker Hub: `production.cloudfront.docker.com:443` is policy-denied at the egress proxy, and no base image is cached. So `docker build` has **never run** against this Dockerfile | First step of deployment — `docs/DEPLOYMENT.md` §1 |
| Docker healthcheck **in a container** | Same. The command itself was run verbatim outside one (exit 0 healthy / 1 unhealthy), and the service was run as uid 1001 against a `0700` volume with `/readyz` answering — but `HEALTHCHECK` as Docker executes it is unproven | `docs/DEPLOYMENT.md` §1 |
| Two gateway containers racing one instance | The single-owner Redis lock is designed (§11.3) but the MVP runs one replica, so there is nothing to race | Before ever scaling to two |
| `keyboard-access.test.ts` false positives | It scans raw source without stripping comments — prose describing markup reads as markup. `rls.convention.test.js` documents fixing exactly this class in the backend | Follow-up in `619-erp-frontend`, not bundled here |
