# WhatsApp Gateway — Architecture

**Service:** `619-erp-whatsapp`
**Consumer:** `619-erp-backend` (the only permitted caller)
**Status:** Phase 1 design. Nothing in this document has been implemented yet.
**Companion:** Phase 0 audit of the existing ERP — the findings this design is built on.

> **This is not the official WhatsApp Cloud API.** It is a WhatsApp **Web**
> client. See §20–§23 before deploying anything here to a real studio's phone
> number. That section is not boilerplate; read it.

---

## Table of contents

1. [System architecture](#1-system-architecture)
2. [Request flow](#2-request-flow)
3. [QR pairing flow](#3-qr-pairing-flow)
4. [Authentication & session lifecycle](#4-authentication--session-lifecycle)
5. [Reconnection strategy](#5-reconnection-strategy)
6. [Multi-tenant architecture](#6-multi-tenant-architecture)
7. [Security model](#7-security-model)
8. [Webhook model](#8-webhook-model)
9. [Message lifecycle](#9-message-lifecycle)
10. [Media lifecycle](#10-media-lifecycle)
11. [Redis & queue strategy](#11-redis--queue-strategy)
12. [Database strategy](#12-database-strategy)
13. [Failure handling](#13-failure-handling)
14. [Logging & observability](#14-logging--observability)
15. [Docker architecture](#15-docker-architecture)
16. [VPS deployment architecture](#16-vps-deployment-architecture)
17. [Backup & recovery](#17-backup--recovery)
18. [Rate limiting](#18-rate-limiting)
19. [Abuse prevention](#19-abuse-prevention)
20. [WhatsApp platform limitations](#20-whatsapp-platform-limitations)
21. [Baileys limitations](#21-baileys-limitations)
22. [Licence considerations](#22-licence-considerations)
23. [Official Meta API vs Baileys](#23-official-meta-api-vs-baileys)

Appendices: [A. API contract](#appendix-a-api-contract) · [B. Event schema](#appendix-b-event-schema) · [C. ERP schema changes](#appendix-c-erp-schema-changes) · [D. Environment variables](#appendix-d-environment-variables) · [E. Open decisions](#appendix-e-open-decisions)

---

## 1. System architecture

### 1.1 Topology

```
┌──────────────────────────────────────────────────────────────────────┐
│  Browser                                                             │
│  Settings → Integrations → WhatsApp                                  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ HTTPS, same-origin /api/*
                                │ httpOnly cookie (sameSite=strict)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  nginx  (myptstudio.com → :3000, api.myptstudio.com → :5000)         │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  619-erp-frontend  (Next.js 16, container :3000)                     │
│  rewrite /api/* → backend                                            │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  619-erp-backend   (Express, container :5000)                        │
│  • BUSINESS AUTHORITY — owns identity, tenancy, RLS, billing          │
│  • resolves organization_id from req.user, never from the client      │
│  • owns the whatsapp_instances table (the studio-facing record)       │
└──────────┬────────────────────────────────────────┬──────────────────┘
           │ ①  HTTP  X-Gateway-Key                 │ ▲
           │     (docker network, never public)     │ │ ②  HMAC-signed
           ▼                                        │ │     webhook
┌──────────────────────────────────────────────────────────────────────┐
│  619-erp-whatsapp  (Fastify, container :8080, NO published port)     │
│  • owns WhatsApp connections, QR, session state, reconnection         │
│  • has NO database credentials — see §12                              │
│  • sessions on a private volume, QR + outbox in Redis                 │
└───────────────────────────────┬──────────────────────────────────────┘
                                ▼
                      Baileys  →  WhatsApp Web
```

### 1.2 The two edges that define the design

**① Backend → Gateway** is the *only* inbound path. The gateway publishes no
host port; it is reachable solely on the Docker network at
`http://myptstudio-whatsapp:8080`. There is **no `wa-api.myptstudio.com`, no
nginx vhost, and no TLS certificate to issue.**

This is a deliberate departure from the brief's tentative hostname. Three
reasons:

1. The brief's own architecture diagram has no browser→gateway edge. Nothing
   needs to reach it from the internet.
2. The Phase 0 audit found that adding an nginx `server` block referencing an
   unissued certificate makes `nginx -t` fail, and a failed test means
   `systemctl restart nginx` leaves nginx **down** — taking `myptstudio.com`
   and `api.myptstudio.com` with it. This is documented in
   `infra/nginx/myptstudio.conf` as the reason `command-center.conf` was split
   out. Not creating a vhost removes that whole class of outage.
3. An unexposed service cannot be scanned, brute-forced, or DoSed from the
   internet. The strongest access control is not being reachable.

**② Gateway → Backend** carries normalised events. It also stays on the Docker
network (`http://myptstudio-backend:5000`), but the receiving route is mounted
on the same Express app that *is* public, so it is HMAC-signed regardless.
Network position is a defence, never the only one.

### 1.3 Stack

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 20 (`node:20-bookworm-slim`) | Baileys requires `>=20`; matches the backend image exactly |
| Language | **TypeScript** | Baileys is TS-first; its socket/event types are the main defence against protocol drift. The ERP stays CommonJS JS — the boundary is HTTP+JSON, so the language split costs nothing |
| HTTP | **Fastify** | The ERP's Express app carries ~40 middleware layers this service does not want. Fastify's schema-per-route validation pairs directly with Zod, and it is faster under the long-lived connections this process holds. No shared code with the ERP is lost — there is none to share |
| WhatsApp | `baileys` **pinned exactly** | See §21.1 for the version decision |
| Validation | **Zod** | Same major line as the backend (`^4`) |
| Logging | **Pino** | Same as the backend. Baileys itself takes a Pino logger, so one logger serves both |
| Store | Filesystem volume + **Redis** | See §12 — the gateway gets no DB credentials |
| Tests | Vitest | TS-native, no ts-jest indirection |

---

## 2. Request flow

Worked example — a studio admin opens the WhatsApp card:

```
1. Browser   GET /api/integrations/whatsapp/status
             Cookie: token=<jwt>                       (sameSite=strict)

2. Backend   auth()          → req.user { id, role, organization_id }
             requireStaff()  → role gate
             orgIdOf(req)    → orgId          ← FROM THE SESSION, NOT THE BODY
             SELECT … FROM whatsapp_instances WHERE organization_id = $1
             → no row?  respond { state: 'never_connected' }, stop here.

3. Backend   GET http://myptstudio-whatsapp:8080/v1/instances/<instance_id>/status
             X-Gateway-Key: <secret>
             X-Org-Id:      <orgId>           ← for cross-checking, not for lookup
             X-Request-Id:  <req.id>

4. Gateway   verifyGatewayKey()      → constant-time compare, fail closed
             loadInstance(id)        → from the in-memory registry
             assertOwner(inst, orgId)→ mismatch ⇒ 404, never 403 (see §7.4)
             → { state, phone_e164, connected_at, last_error_code }

5. Backend   merges gateway truth with its own row, refreshes the row if they
             disagree, responds to the browser.
```

**The invariant, stated once:** the organization id is derived by the backend
from the authenticated session and is *never* read from a request body, query
string, or client-supplied header. This is not a new rule — `lib/tenant-db.js`
in the ERP documents that `?organization_id=` and body fields were deliberately
removed because the RLS GUC and the application filter could then disagree
about the active tenant *within one request*. This design does not reintroduce
that.

`X-Org-Id` on hop ③ is a **cross-check, not a lookup key**. The gateway finds
the instance by its own id and then asserts the presented org matches the one
stored on it. A wrong org cannot select a different instance; it can only fail.

---

## 3. QR pairing flow

### 3.1 Sequence

```
Admin clicks "Connect WhatsApp"
        │
        ▼
POST /api/integrations/whatsapp/connect        (backend, authenticated)
        │  orgId ← session
        │  INSERT whatsapp_instances (organization_id, …) ON CONFLICT DO NOTHING
        │  one instance per org — see §6.3
        ▼
POST /v1/instances                              (gateway)
        │  { instance_id, organization_id }
        │  creates session dir, starts Baileys socket
        │  → 201 { instance_id, state: 'connecting' }
        ▼
Baileys emits connection.update { qr: "<string>" }
        │  gateway: SET wa:qr:<instance_id> = <string>  EX 60
        │  gateway: emit whatsapp.instance.qr → backend webhook
        ▼
Frontend polls GET /api/integrations/whatsapp/qr  every 2s while modal open
        │  backend → GET /v1/instances/:id/qr → { qr, expires_in_ms }
        │  frontend renders with `qrcode-generator` (already a dependency)
        ▼
User: WhatsApp → Linked Devices → Link a Device → scan
        ▼
Baileys emits connection.update { connection: 'open' }
        │  gateway: DEL wa:qr:<instance_id>
        │  gateway: persist creds (see §4)
        │  gateway: emit whatsapp.instance.connected { phone_e164, jid_hash }
        ▼
Backend webhook → UPDATE whatsapp_instances SET status='connected', …
        ▼
Frontend's next poll returns { state: 'connected', phone_e164 }
        → 🟢 WhatsApp Connected
```

### 3.2 Why polling, not SSE or WebSocket

The Phase 0 audit established that the frontend's `/api/*` calls reach the
backend through a **Next.js rewrite, and that hop does not carry a WebSocket
Upgrade**. A WebSocket must address `api.myptstudio.com` directly, which needs
its own nginx `location`, a ticket handshake (the Command Center's pattern), and
a 3600s read timeout.

Weighed against what QR actually needs:

- A QR is valid for ~20s and the whole pairing takes under a minute.
- A 2s poll for 60s is **30 requests**, once, per studio, per connect.
- The modal is open and focused the entire time; polling stops when it closes.

Thirty requests do not justify a new nginx location, a ticket endpoint, and a
reconnecting client. **Poll.** If Phase 10's real-device test shows the QR
feeling laggy, `lib/sse-heartbeat.js` already exists in the backend and SSE
rides the existing rewrite with only a `proxy_read_timeout` bump — a contained
follow-up, not a rewrite.

### 3.3 QR expiry

Baileys re-emits `connection.update` with a fresh `qr` roughly every 20s, and
gives up after a few rounds. The gateway:

- stores each QR at `wa:qr:<instance_id>` with **`EX 60`** — comfortably longer
  than the refresh interval, so a poll never lands in a gap, and short enough
  that a stale QR cannot be scanned into a confusing half-state;
- returns `410 Gone` with `{ code: 'QR_EXPIRED' }` when the key is absent and
  the instance is not connected, so the UI shows "QR expired — try again"
  rather than an infinite spinner;
- caps a pairing attempt at **`WA_QR_MAX_ROUNDS` (default 5)**, then closes the
  socket and moves the instance to `qr_timeout`. An abandoned modal must not
  leave a socket open forever.

---

## 4. Authentication & session lifecycle

### 4.1 States

```
                      POST /v1/instances
                              │
                              ▼
   ┌──────────────┐      ┌──────────┐  qr rounds     ┌────────────┐
   │ never_       │─────▶│connecting│───exhausted───▶│ qr_timeout │
   │ connected    │      └────┬─────┘                └─────┬──────┘
   └──────────────┘           │ scanned                    │ reconnect
                              ▼                            │
                        ┌───────────┐◀─────────────────────┘
             ┌─────────▶│ connected │
             │          └─────┬─────┘
     reconnect│                │ socket drop
     succeeds │                ▼
             │          ┌──────────────┐   backoff ceiling   ┌─────────┐
             └──────────│ reconnecting │────exhausted───────▶│ failed  │
                        └──────┬───────┘                     └─────────┘
                               │ 401 from WhatsApp
                               ▼
                        ┌────────────┐
                        │ logged_out │  ← creds destroyed, QR required
                        └────────────┘
```

`logged_out` is terminal for the credentials. It means the user tapped "Log
out" on their phone, or WhatsApp invalidated the device. The gateway **deletes
the auth state** and requires a fresh QR — retrying with dead credentials is
how an account gets flagged.

### 4.2 Persistence

Baileys' auth state is two things: long-lived **credentials** (device identity,
Signal identity keys, registration id) and high-churn **key material**
(pre-keys, sender keys, app-state sync keys). It is written through a
`saveCreds` callback on every `creds.update`.

Layout, one directory per instance:

```
/data/sessions/<instance_id>/
    creds.json
    app-state-sync-key-<id>.json
    pre-key-<n>.json
    …
```

Rules, each with a reason:

| Rule | Reason |
|---|---|
| `<instance_id>` is validated as a **UUID v4 before touching the path** | The only path-traversal defence that actually holds. Never interpolate an unvalidated id into a path |
| Writes are **atomic**: temp file in the same directory, `fsync`, `rename` | A container killed mid-write otherwise leaves truncated JSON, which is the single most common way a Baileys instance becomes unrecoverable |
| Directory mode `0700`, files `0600`, owned by the non-root runtime user | A volume snapshot is the realistic leak path |
| Never in git — `/data` is a volume, and `.gitignore` covers `data/` anyway | Auth state is full account access |
| **Never returned by any API endpoint**, at any verbosity | There is no legitimate reader outside this process |
| `saveCreds` writes are **serialised per instance** (`async-mutex`, already a Baileys dependency) | Concurrent writes to the same key file interleave and corrupt |

**Encryption at rest** is deliberately left as an [open decision](#appendix-e-open-decisions).
AES-256-GCM with a key from `WA_SESSION_ENC_KEY` would protect a stolen volume
snapshot or a backup tarball. It protects nothing against a compromised running
process, since that process must hold the key. It also makes recovery harder:
lose the key and every studio re-scans. Worth doing, but it is a Phase 4
decision with a real trade-off, not a default.

### 4.3 Restart behaviour

On boot the gateway reads `/data/instances.json` — a manifest of
`{ instance_id, organization_id, created_at }` written on every instance
create/delete — and restores every instance whose session directory has a
readable `creds.json`.

**The manifest is why the gateway needs no database.** It is the gateway's own
copy of "which instances exist and who owns them", it lives on the same volume
as the sessions it describes, and it is backed up with them. Restore is:
mount the volume, start the container, sockets reconnect. **No QR rescan.**

Written with the same atomic temp+rename as the session files.

---

## 5. Reconnection strategy

### 5.1 Classify before retrying

Baileys surfaces a `DisconnectReason` on close. Retrying blindly is the fastest
route to a banned number, so every close is classified first:

| Cause | Action |
|---|---|
| `loggedOut` (401) | **Stop.** Destroy creds, state → `logged_out`, emit `whatsapp.instance.logged_out`. Requires a new QR |
| `restartRequired` | Immediate reconnect, no backoff — this is Baileys asking, not a failure |
| `connectionReplaced` | **Stop.** The same number paired elsewhere. Reconnecting would fight the other session and flap both |
| `badSession` / unreadable creds | Destroy creds, state → `logged_out`, require QR (§13.2) |
| `connectionClosed`, `connectionLost`, `timedOut` | Backoff reconnect |
| Anything else | Backoff reconnect, log the raw code at `warn` |

### 5.2 Backoff

Exponential with full jitter, matching the ERP's BullMQ posture:

```
delay = min(WA_RECONNECT_BASE_MS * 2^attempt, WA_RECONNECT_MAX_MS)
sleep   random(0, delay)          // full jitter
```

Defaults: base **2 000 ms**, ceiling **300 000 ms** (5 min), **`WA_RECONNECT_MAX_ATTEMPTS` = 10**
→ roughly 25 minutes of trying before the instance goes `failed`.

Full jitter, not fixed backoff, because a gateway restart would otherwise
reconnect every studio in lockstep — a self-inflicted thundering herd against
WhatsApp's servers from one IP, which is exactly the traffic shape that gets an
IP rate-limited.

`failed` is not terminal for the *credentials*: `POST …/reconnect` resets the
attempt counter and tries again. It only means the gateway has stopped
retrying on its own.

---

## 6. Multi-tenant architecture

### 6.1 The model

```
organizations (ERP, UUID PK)
     │ 1
     │
     │ 1
whatsapp_instances (ERP table — the business record, RLS-covered)
     │  organization_id UNIQUE   ← one instance per studio in MVP
     │  instance_id
     │  status, phone_e164, connected_at, last_error_code
     │
     ├──▶ gateway manifest entry   { instance_id, organization_id }
     └──▶ gateway session dir      /data/sessions/<instance_id>/
```

The ERP's `organizations` table is the tenant identity. **No second tenancy
model is created** — the gateway stores an `organization_id` it was given and
compares it; it never resolves, mints, or interprets one.

### 6.2 Isolation, enforced at four points

| # | Point | Mechanism |
|---|---|---|
| 1 | Backend read/write of `whatsapp_instances` | `orgWhere(req, params)` → `AND organization_id = $N`, org from session |
| 2 | Postgres | RLS `tenant_isolation` policy on `organization_id::text = current_setting('app.org_id')` — **automatic**, because migrations 157/158 discover every table carrying `organization_id`. §12.3 |
| 3 | Backend → gateway | Backend sends the session-derived org; it never forwards a client value |
| 4 | Gateway | `assertOwner()` on **every** instance-scoped operation, before any work |

Studio A cannot reach Studio B's instance because A's session resolves to A's
`organization_id` (point 1), the database would refuse the row anyway (point 2),
A's instance id is never learned, and presenting B's id with A's org fails the
ownership assert (point 4). Four independent failures required.

### 6.3 One instance per organization (MVP)

Enforced by `UNIQUE (organization_id)` on `whatsapp_instances`. The schema keeps
`instance_id` as a separate column rather than reusing `organization_id` as the
key, so lifting the constraint later is a migration and not a redesign.

Justification: the product UX is "Connect WhatsApp", singular. A studio with two
numbers is a real future case; it is not an MVP case, and the constraint is the
cheapest way to make "which instance did they mean?" un-askable today.

### 6.4 Super admin

A platform `super_admin` has **no** `organization_id`. Per `tenant-db.js`, they
operate platform-wide unless they name a studio with `x-org-id`.

For WhatsApp specifically: **connecting or disconnecting an instance requires a
resolved org**. A platform-wide super admin gets `400 — Select a studio first`,
exactly as `routes/integrations.js` already does in `writableOrg()`. Pairing a
WhatsApp number is inherently a tenant action; there is no sensible
platform-wide meaning for it.

---

## 7. Security model

### 7.1 Trust boundaries

```
internet ──┤ nginx ├── frontend ──┤ rewrite ├── backend ──┤ docker net ├── gateway
           TLS               untrusted user      AUTHZ         shared         no
                                                 BOUNDARY      secret       public
                                                                            port
```

The backend is the authorization boundary. The gateway authenticates **that the
caller is the backend** and nothing more — it makes no user-level decisions
because it has no user context, and giving it one would duplicate an
authorization model that already exists and works.

### 7.2 Backend → gateway auth

Header `X-Gateway-Key`, secret `WA_GATEWAY_KEY` (≥32 bytes, random).

Copied deliberately from the ERP's `middleware/serviceAuth.js`:

```ts
// SHA-256 both sides first. timingSafeEqual throws on a length mismatch, and
// returning early on that throw leaks the secret's LENGTH through response
// timing. Hashing makes every comparison run over exactly 32 bytes.
function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}
```

- Missing/blank secret in the environment ⇒ the process **refuses to start**.
  A half-configured deploy that answers "fine" to unverifiable claims is worse
  than one that does not boot.
- Wrong key ⇒ `401`, and the presented value is **never logged**. A near-miss in
  a log file is the most useful thing an attacker could write there.
- The key is the *whole* credential on this hop, which is acceptable only
  because the hop never leaves the Docker network. If the gateway is ever
  exposed publicly, this must be upgraded to mTLS or request signing —
  recorded in [Appendix E](#appendix-e-open-decisions).

### 7.3 Gateway → backend auth

HMAC-SHA256 over `timestamp + "." + rawBody`, secret `WA_WEBHOOK_SECRET`:

```
X-WA-Timestamp: 1756713600
X-WA-Signature: sha256=<hex>
X-WA-Event-Id:  <uuid v4>
```

Verified exactly as `routes/razorpay-webhook.js` does — raw body preserved by
mounting `express.raw()` **before** `express.json()`, explicit length check
before `timingSafeEqual`. Plus two things Razorpay's handler lacks and this one
needs:

- **Timestamp window** — reject outside ±300s, so a captured request cannot be
  replayed tomorrow.
- **Idempotency ledger** — `whatsapp_webhook_events(event_id PK)`. A duplicate
  `event_id` returns `200 {received:true, duplicate:true}` without re-applying.
  At-least-once delivery (§11.2) makes duplicates normal, not exceptional.

### 7.4 Mismatched ownership returns 404, not 403

`403` confirms the resource exists. `404` does not. Since instance ids are
UUIDs, a `404` is also honest: *within the caller's tenant*, that instance does
not exist. Enumeration gains nothing.

### 7.5 Controls checklist

| Control | Decision |
|---|---|
| Helmet | Yes — `@fastify/helmet`, though a JSON-only internal API gains little |
| CORS | **Disabled entirely.** No browser may call this service. Not a restrictive policy — an absent one |
| Rate limiting | `@fastify/rate-limit`, Redis-backed. §18 |
| Body limit | **64 KB** (no media in MVP) |
| Input validation | Zod on every route, `instance_id` as strict UUID |
| SSRF | The gateway makes **exactly one** outbound HTTP call, to `WA_BACKEND_URL`, a fixed env value. No caller-supplied URL is ever fetched. Media downloads in Phase ≥9 go through Baileys to WhatsApp CDN hosts only |
| Path traversal | UUID validation before any path join; §4.2 |
| Secret leakage | Pino redaction list (§14.2); explicit deny-list, not best-effort |
| Recipient validation | E.164 + backend-side contact check. §19 |
| Error shape | `{ error: { code, message } }`, stable codes, no stack traces, no upstream error text |

### 7.6 Never logged, never returned

Auth state · private/identity/pre-keys · `WA_GATEWAY_KEY` · `WA_WEBHOOK_SECRET` ·
`REDIS_URL` credentials · raw message bodies · full phone numbers at `info`
(last 4 digits only; full number only at `debug`, which is off in production).

---

## 8. Webhook model

### 8.1 Envelope

Baileys' own events are **not** the contract. They change between versions and
carry protocol detail the ERP has no business knowing. The gateway normalises
to a stable envelope ([full schema in Appendix B](#appendix-b-event-schema)):

```jsonc
{
  "schema_version": 1,
  "event_id":       "9f1c…",          // UUID v4 — the idempotency key
  "event_type":     "whatsapp.instance.connected",
  "instance_id":    "3b7e…",
  "tenant_id":      "1a2b…",          // organization_id
  "occurred_at":    "2026-09-01T10:22:31.004Z",
  "payload":        { }               // per-type, see Appendix B
}
```

`schema_version` is present from day one. Adding it later means guessing what
an unversioned event meant.

### 8.2 Types

**MVP:**
`whatsapp.instance.created` · `.qr` · `.connecting` · `.connected` ·
`.disconnected` · `.logged_out` · `.deleted`

**Post-MVP, defined now so the ledger and consumer are built once:**
`whatsapp.message.received` · `.sent` · `.delivered` · `.read` · `.failed`

### 8.3 The `.qr` event carries no QR

`whatsapp.instance.qr` announces *that* a QR is available and when it expires.
The QR string itself is fetched over the authenticated `GET /v1/instances/:id/qr`.

A QR is a pairing credential. Anyone who scans it links a device to that
studio's WhatsApp. Pushing it into an event puts it in the backend's request
logs, the ledger table, and any future event archive — several durable places
it has no business being.

### 8.4 Delivery

Redis outbox → `POST {WA_BACKEND_URL}/api/webhooks/whatsapp` → 6 attempts,
exponential backoff with jitter (2s → ~64s), then the dead-letter list. §11.2.

**Non-2xx is a retry; 2xx is done.** The backend returns 200 for a duplicate,
because a duplicate *is* success from the sender's point of view.

---

## 9. Message lifecycle

> **Not in the MVP.** Documented so the MVP's event ledger, provider seam, and
> rate limiter are built once, correctly, rather than retrofitted. No send
> endpoint ships in the MVP.

### 9.1 The existing ERP path, unchanged

```
caller → enqueueWhatsapp('text', {…})
       → redis.ensureReady() ? whatsappQueue.add() : inline
       → whatsapp.worker.js → processWhatsappJob
       → whatsappDelivery.sendText()  →  Twilio
```

### 9.2 The seam

One new module, `src/services/whatsappProvider.js`, in front of the existing
transport. **`whatsappDelivery.js` is not edited.**

```js
// Resolve the provider for ONE organization.
//   1. a connected gateway instance   → the studio's own number
//   2. else Twilio env configured     → the existing path, untouched
//   3. else                           → { status: 'not_configured' }
```

Two call sites change — `whatsapp.service.js`'s `processWhatsappJob` and the
`whatsapp` adapter in `notifications.service.js`. Both currently
`require('./whatsappDelivery')` directly; both become `require('./whatsappProvider')`.

The result contract is **identical**, because the worker's retry semantics are
built on it:

```js
{ status: 'sent',           provider_id }  // terminal, success
{ status: 'not_configured', provider_id: null }  // terminal, NO retry
{ status: 'failed',         error }        // throws in the worker ⇒ BullMQ retry
```

`notifications.service.js` carries a long comment about an incident where
`not_configured` returned `sent` with a fabricated provider id, making
undelivered email indistinguishable from delivered. **Reproducing that here
would be repeating a known, documented incident.** The provider returns
`not_configured` and means it.

### 9.3 No fallback between providers

If a studio's own instance is connected but the send fails, it fails. It does
**not** fall back to Twilio.

Twilio sends from the **platform's** number. A client who has been messaging
their gym on the gym's number would receive a message from an unknown
international number — worse than a delayed message, and it teaches clients to
trust a number the studio does not control.

### 9.4 Status mapping

Baileys `messages.update` acks map to the ERP's existing
`communication_logs.status` CHECK — `('queued','sent','delivered','read','failed','bounced')`:

| Baileys ack | ERP status |
|---|---|
| `PENDING` | `queued` |
| `SERVER_ACK` | `sent` |
| `DELIVERY_ACK` | `delivered` |
| `READ` | `read` |
| `ERROR` / `PLAYED`-only failures | `failed` |

The existing vocabulary fits without alteration — §12.2.

---

## 10. Media lifecycle

> **Not in the MVP.** Body limit is 64 KB precisely so that shipping media
> becomes a deliberate change rather than something that quietly starts working.

When it lands:

- **Outbound** — the backend uploads to R2 (`lib/fileStorage.js`, already in
  place) and hands the gateway a **short-lived signed URL**, not bytes. Keeps
  large bodies off the internal hop and keeps one storage authority.
- **Inbound** — Baileys decrypts; the gateway streams to R2 under
  `whatsapp/<organization_id>/<instance_id>/<message_id>` and the event carries
  the **key only**, never the bytes. The tenant prefix makes lifecycle rules and
  per-tenant deletion trivial.
- **Never** written to the session volume. That volume is auth state and is
  backed up as secrets; mixing client media into it changes what a backup is.
- Type allow-list and a hard size cap **before** decryption, not after.
- Filenames from WhatsApp are attacker-controlled: content-addressed storage
  keys, never the supplied name.

---

## 11. Redis & queue strategy

### 11.1 Shared instance, separate keyspace

The gateway uses the **existing** `myptstudio-redis` container, prefix `wa:`.

The ERP's Redis runs `appendonly yes` and `maxmemory-policy noeviction`
— chosen, per the compose comments, because an LRU policy would silently evict
BullMQ job hashes. That same durability is exactly what the outbox needs, so
this is reuse of a correct decision rather than a new dependency.

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `wa:qr:<instance_id>` | string | 60s | Current QR |
| `wa:outbox` | list | — | Pending events (LPUSH / BRPOPLPUSH) |
| `wa:outbox:processing` | list | — | In-flight, for crash recovery |
| `wa:outbox:dead` | list | 7d | Exhausted retries |
| `wa:ratelimit:<instance_id>` | string | 60s | Token bucket (§18) |
| `wa:lock:<instance_id>` | string | 30s | Single-owner lock (§11.3) |

### 11.2 The outbox

`BRPOPLPUSH wa:outbox wa:outbox:processing` — the reliable-queue pattern. An
event is removed from `processing` only after a 2xx. A crash mid-delivery
leaves it in `processing`, and a sweeper returns anything older than 60s to the
main list.

This is **at-least-once**. Duplicates are normal and expected, which is why
§7.3's idempotency ledger is not optional.

No BullMQ here, deliberately: BullMQ is the *ERP's* queue, and pointing a
second service's producers at it would put this service inside the ERP's
`bullmq.connections.test.js` invariants for no gain. A Redis list is the right
size for one outbox.

### 11.3 Single-owner lock

Two gateway processes holding sockets for the same instance would fight over
`creds.json` and corrupt it. Before starting a socket, the gateway acquires
`SET wa:lock:<instance_id> <process_id> NX EX 30`, refreshed every 10s while
the socket lives.

**The MVP runs exactly one gateway container** (§15.3) — this lock is what makes
that a *checked* invariant rather than an assumption that quietly breaks the
first time someone scales the service to two replicas.

### 11.4 Redis unavailable

The ERP degrades to inline sends when Redis is down. The gateway **cannot**:
QR storage, the outbox, and the ownership lock all require it. So Redis is a
**hard dependency** — `depends_on: service_healthy`, and readiness reports
`not ready` without it, which stops the container from being treated as
serving. Being honestly unavailable beats running with a broken lock.

---

## 12. Database strategy

### 12.1 The gateway gets no database credentials

**This is the most consequential decision in the document.**

The gateway holds no connection string, no Supabase key, no pooler
credentials. It cannot read a client, a payment, or another tenant's row —
because it cannot reach the database at all.

It works because the gateway's *own* durable state is small and naturally
file-shaped: session credentials (already files), a ~200-byte-per-instance
manifest, and transient QR/queue state (Redis). Adding Postgres would buy
nothing and would hand the ERP's most security-sensitive asset to the process
with the largest third-party dependency tree and an unofficial protocol
implementation. Instead:

| State | Owner | Store |
|---|---|---|
| Business record: who has WhatsApp, status, phone, timestamps | **Backend** | Postgres, RLS-covered |
| Auth state | **Gateway** | `/data/sessions/` volume |
| Instance manifest | **Gateway** | `/data/instances.json` |
| QR, outbox, locks | **Gateway** | Redis |
| Message history | **Backend** | `communication_logs` (existing) |

The gateway is the authority on *connection* state; the backend is the
authority on *business* state; events reconcile them, and the backend's status
call is the tiebreak.

### 12.2 Reuse `communication_logs`

The existing table already models a message stream — `direction`
(`outgoing`/`incoming`), the exact status vocabulary of §9.4, `external_id` for
the provider's id, `channel` already CHECKing `'whatsapp'`, `recipient_phone`,
and `sent_at`/`delivered_at`/`read_at`.

Post-MVP it needs one column, `provider TEXT` (`'twilio' | 'baileys'`), so the
two paths are distinguishable in reporting. **No `whatsapp_messages` table.**
The brief floated one; the audit found the existing table already fits, and a
parallel table would split message history across two schemas and every report
that reads it.

`whatsapp_contacts` is likewise **not created** — `pt_clients` already carries a
`whatsapp` column (migration 052) and is the tenant's contact record.

### 12.3 One new table

`whatsapp_instances` — [full DDL in Appendix C](#appendix-c-erp-schema-changes).
Plus `whatsapp_webhook_events` for the idempotency ledger.

Both carry `organization_id UUID REFERENCES organizations(id)`, so **RLS covers
them automatically**: migrations 157/158 loop over
`information_schema.columns` for `organization_id` and attach the
`tenant_isolation` policy. Re-running that block is all that is required — no
hand-written policy to drift out of sync.

Migration number **185**. (184 is the highest currently used; note 174/175/176
already have duplicate numbering in the repo, so the next free number is not
simply "one more than the count of files".)

### 12.4 Why the session store is hand-written *(added in Phase 3)*

Baileys ships `useMultiFileAuthState`, and its own doc comment says:

> *"I wouldn't endorse this for any production level use other than perhaps a
> bot. Would recommend writing an auth state for use with a proper SQL or
> No-SQL DB"*

We are deliberately not using a database (§12.1), so the answer is to write the
file-backed store properly rather than accept a helper its own authors flag as
unsuitable. `src/store/authState.ts` differs in three concrete ways, each of
which is a real failure this service would otherwise inherit:

| | Baileys' helper | Ours |
|---|---|---|
| Write | `writeFile` — a kill mid-write leaves truncated JSON, and a truncated `creds.json` is an unrecoverable session (§13.2) | temp + `fsync` + `rename`: a kill at any instant leaves either the old file or the new one |
| Locking | a module-level `Map` of one mutex per file path, never evicted — pre-key files churn constantly, so it grows for the life of the process | one serializer per instance, bounded by `WA_MAX_INSTANCES` |
| Filenames | maps `/` and `:` out of the way; does not refuse `..` or bound length | validates and refuses; long ids truncated with a hash suffix so they stay injective |

The `/` → `__` and `:` → `-` substitutions are kept **identical** on purpose: a
session directory written by Baileys' helper stays readable by ours, which is
the difference between swapping an implementation and forcing every studio to
re-scan a QR.

---

## 13. Failure handling

| Failure | Detection | Response |
|---|---|---|
| Gateway unreachable | Backend fetch times out (**3s connect / 10s total**) | Backend serves its last known DB row with `stale: true`. The UI shows the last state greyed, not an error page |
| Gateway 5xx | Status code | Same as above; logged at `error` with `request_id` |
| Redis down | `ensureReady()` false | Readiness → not ready. New instances refused; existing sockets keep running but events buffer in memory and are dropped past 1 000 with a counter — memory is not a queue |
| Backend webhook down | Non-2xx / timeout | Outbox retries 6× then dead-letters. The backend's own status poll reconciles, so a missed event delays the UI, it does not corrupt state |
| Session corrupted | `creds.json` unparseable, or `badSession` | §13.2 |
| WhatsApp `logged_out` | `DisconnectReason.loggedOut` | Destroy creds, emit, require QR. **Never retry** |
| Two containers, one instance | Lock contention | Loser refuses to start that socket and logs at `error`. §11.3 |
| Disk full | `ENOSPC` on `saveCreds` | Instance → `failed`, alert. Atomic writes mean the *old* creds survive intact — the single most important property here |
| OOM | Container restart | Sessions persist; instances restore from the manifest. No QR rescan |

### 13.2 Corrupted-session recovery

```
read creds.json
  ├── parses & has a device identity  → restore, connect
  ├── unparseable / truncated
  │     └── .bak present and valid?   → restore from .bak, log at warn
  │           └── else                → quarantine to
  │                                     /data/quarantine/<instance_id>-<ts>/,
  │                                     state → logged_out, require QR
  └── absent                          → state → never_connected, require QR
```

The previous `creds.json` is kept as `creds.json.bak` on each successful write —
one generation, which covers the realistic case (a bad write) without turning
the volume into an archive of account credentials.

Quarantine rather than delete: a corrupted session is evidence, and deleting it
destroys the only artefact that explains what happened. Retained
`WA_QUARANTINE_RETENTION_DAYS` (default 7), then swept — on boot and daily,
because a gateway that stays up for months would otherwise never sweep.

**Implemented in Phase 4** (`src/store/sessionRecovery.ts`), with three details
the diagram above does not capture:

- **"Parses" is not enough.** A truncated write can land on syntactically valid
  JSON, so `looksLikeCreds` also requires a device identity — the Noise key, the
  signed identity key, and a numeric registration id. Without that check an
  `{}` would be handed to Baileys as a session and fail much later, and far less
  legibly.

- **The backup is written from the current on-disk bytes *before* the new
  credentials replace them.** That ordering is what guarantees at least one
  valid copy at every instant; writing the new creds first would leave a window
  where `.bak` holds a version two generations back — the copy least likely to
  help.

- **A recovered backup is promoted to primary immediately.** Leaving the damaged
  file in place would re-run recovery on every restart, and a second corruption
  would then find no backup left.

The regression this closes is worth naming: before Phase 4 an unparseable
`creds.json` was swallowed and fresh credentials were minted over it. A studio
that *was* paired would show as `never_connected`, be invited to scan a new QR,
and the first `creds.update` after that would overwrite the only copy that might
still have been recoverable. A transient read error could silently destroy a
working pairing.

---

## 14. Logging & observability

### 14.1 Structured logs

Pino JSON to stdout — Docker collects it, matching the backend exactly.

Every operation-scoped line carries:

```jsonc
{
  "request_id":  "…",   // X-Request-Id from the backend, or generated
  "tenant_id":   "…",   // organization_id
  "instance_id": "…",
  "event_id":    "…",   // where applicable
  "operation":   "instance.connect",
  "status":      "ok",  // ok | error | timeout
  "duration_ms": 142
}
```

### 14.2 Redaction is an explicit deny-list

```ts
redact: {
  paths: [
    'req.headers["x-gateway-key"]',
    'req.headers.authorization',
    'creds', 'state.creds', '*.creds',
    'qr',                      // the QR string is a pairing credential
    '*.privateKey', '*.pubKey', '*.signedPreKey', '*.identityKey',
    'payload.body', 'payload.message',
  ],
  remove: true,
}
```

**Baileys' own logger is given a child of this logger**, so protocol-level debug
output goes through the same redaction. A separate logger for Baileys is how
key material reaches a log file.

### 14.3 Endpoints

| Endpoint | Auth | Semantics |
|---|---|---|
| `GET /healthz` | none | **Liveness** — the process is up. Used by `HEALTHCHECK`. Never touches Redis: a liveness probe that fails on a dependency outage restart-loops a healthy process |
| `GET /readyz` | none | **Readiness** — Redis reachable, session volume writable, manifest loaded |
| `GET /metrics` | `X-Gateway-Key` | Counters (§14.4). Authenticated because per-tenant counts are tenant data |

### 14.4 Metrics

`wa_instances_total{state}` · `wa_qr_generated_total` · `wa_connections_total` ·
`wa_reconnects_total{reason}` · `wa_logouts_total` · `wa_outbox_depth` ·
`wa_outbox_dead_total` · `wa_webhook_delivery_duration_ms` ·
`wa_session_write_errors_total`

`wa_outbox_dead_total > 0` and `wa_session_write_errors_total > 0` are the two
that should page. Both mean silent data loss.

### 14.5 Error classification

| Class | HTTP | Retry? |
|---|---|---|
| `VALIDATION_ERROR` | 400 | No |
| `UNAUTHORIZED` | 401 | No |
| `INSTANCE_NOT_FOUND` (incl. ownership mismatch) | 404 | No |
| `INSTANCE_CONFLICT` (already exists / wrong state) | 409 | No |
| `QR_EXPIRED` | 410 | Yes, after a new connect |
| `RATE_LIMITED` | 429 | Yes, honour `Retry-After` |
| `UPSTREAM_UNAVAILABLE` (WhatsApp) | 502 | Yes |
| `NOT_READY` (Redis/volume) | 503 | Yes |
| `INTERNAL` | 500 | Maybe — investigate |

---

## 15. Docker architecture

### 15.1 Image

```dockerfile
# ── build ──────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci                      # dev deps needed to compile TS
COPY tsconfig.json ./
COPY src ./src
RUN npm run build               # → dist/

# ── deps (production only) ─────────────────────────────────────────────
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs wa \
 && mkdir -p /data && chown wa:nodejs /data && chmod 700 /data
COPY --from=deps  --chown=wa:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=wa:nodejs /app/dist        ./dist
COPY --chown=wa:nodejs package.json ./
USER wa
ENV NODE_ENV=production PORT=8080 WA_SESSION_DIR=/data/sessions
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
```

Notes on choices that are not arbitrary:

- **`bookworm-slim`, not Alpine.** The backend uses `node:20-bookworm-slim`;
  matching the base means one glibc to reason about. Baileys 7's Rust
  dependency is **WebAssembly**, not a native addon (no `os`/`cpu` fields, no
  platform-specific optional deps), so it needs no build toolchain and no musl
  variant — but this must be **re-verified at Phase 2 install time**, because it
  is the single fact that would most change this Dockerfile.
- **Healthcheck uses `node -e` + `fetch`, not `curl`.** The backend's image
  calls `curl`, which `slim` does not ship — adding it is an unnecessary package
  in a production image when Node 20 has global `fetch`.
- **If `baileys@6.7.24` is chosen instead of 7.x**, the build stage additionally
  needs `git`, because 6.7.24 resolves `libsignal` from a raw git URL. §21.1.
- **No secrets in the image.** Every value comes from the environment.

### 15.2 Graceful shutdown

On `SIGTERM`: stop accepting HTTP → flush the outbox (bounded, 10s) → release
every instance lock → `sock.end()` on each socket (a clean WhatsApp close, not a
dropped TCP connection) → final `saveCreds` → exit. Budget **25s**, under
compose's `stop_grace_period: 30s`.

A dropped connection without a clean close is one of the patterns that looks
like abuse to WhatsApp. This is worth the 25 seconds.

### 15.3 Compose

```yaml
  whatsapp:
    build: ../619-erp-whatsapp
    container_name: myptstudio-whatsapp
    restart: unless-stopped
    # NO `ports:` — deliberate. Internal to the compose network only.
    environment:
      NODE_ENV: production
      PORT: '8080'
      WA_GATEWAY_KEY:    ${WA_GATEWAY_KEY}
      WA_WEBHOOK_SECRET: ${WA_WEBHOOK_SECRET}
      WA_BACKEND_URL:    http://myptstudio-backend:5000
      REDIS_URL:         ${REDIS_URL:-redis://redis:6379}
      WA_SESSION_DIR:    /data/sessions
      LOG_LEVEL:         ${WA_LOG_LEVEL:-info}
    volumes:
      - whatsapp-sessions:/data
    depends_on:
      redis:
        condition: service_healthy
    stop_grace_period: 30s
    deploy:
      resources:
        limits:
          memory: 1G       # see §21.3 — measure before trusting this

volumes:
  whatsapp-sessions:
```

**One replica.** Baileys holds sockets in-process; two containers would fight
over session files. §11.3's lock enforces it; this is not the kind of service
you scale by adding replicas without a redesign.

⚠️ **The live compose file is `/opt/myptstudio/docker-compose.yml` on the VPS,
outside every repository, with services named `backend`/`frontend`.** The
snippet above is a reconciliation instruction for that file, not something a
deploy applies. §16.

---

## 16. VPS deployment architecture

### 16.1 Target

```
Hostinger VPS
├── nginx                     :80 :443           ← UNCHANGED
├── myptstudio-frontend       127.0.0.1:3000
├── myptstudio-backend        127.0.0.1:5000
├── myptstudio-redis          127.0.0.1:6379
└── myptstudio-whatsapp       (no host port)     ← NEW
```

**No nginx change. No new certificate. No new DNS record.** The gateway is
reachable only from the backend, over the compose network.

This is the single largest risk reduction in the deployment plan. Per §1.2, an
nginx block referencing an unissued cert fails `nginx -t`, and a failed test
takes nginx — and therefore the entire product — down on the next restart.

### 16.2 Rollout

The full runbook is `docs/DEPLOYMENT.md` (Phase 12). Order and rationale:

1. Generate `WA_GATEWAY_KEY` and `WA_WEBHOOK_SECRET` (`openssl rand -hex 32`),
   add to `/opt/myptstudio/.env` on the box. **Never committed.**
2. Add the `whatsapp` service to the VPS compose by hand, diffing against §15.3.
3. `docker compose build whatsapp && docker compose up -d whatsapp`
4. Verify from *inside* the network — the correctness check is that it is **not**
   reachable from outside:
   ```
   docker compose exec backend node -e \
     "fetch('http://myptstudio-whatsapp:8080/healthz').then(r=>console.log(r.status))"
   curl -sS --max-time 5 https://wa-api.myptstudio.com/healthz   # must FAIL
   ```
5. Deploy the backend (migration 185 runs before the container serves, per the
   existing deploy script) **with the WhatsApp feature flag off**.
6. Deploy the frontend.
7. Enable for **one** studio. Real QR scan (Phase 10).
8. Widen only after that studio has stayed connected across a deliberate
   `docker compose restart whatsapp`.

### 16.3 Feature flag

The ERP already has a feature manager (migration 123) with an `integrations`
feature. The WhatsApp card ships behind a flag so step 7 is a database update,
not a deploy — and so the rollback in §17.3 is instant.

---

## 17. Backup & recovery

### 17.1 What is actually at risk

The `whatsapp-sessions` volume. Lose it and **every studio must re-scan a QR** —
recoverable, but a support incident across the whole customer base.

Everything else already has a backup story: the ERP tables are in Supabase's
backups; Redis holds only transient state.

### 17.2 Backing up account credentials safely

The volume contains **full WhatsApp account access**. A backup of it is a
secret, and must be handled as one:

```bash
docker run --rm \
  -v myptstudio_whatsapp-sessions:/data:ro \
  -v /opt/myptstudio/backups:/backup \
  alpine tar czf /backup/wa-sessions-$(date +%F).tar.gz -C /data .
```

- Encrypt at rest (`age` or `gpg`) — an unencrypted tarball of session
  credentials on the same box adds a second copy of the crown jewels with none
  of the volume's `0700` protection.
- **Off-box**, or it does not survive the failure it exists for.
- Retain 7 daily. Longer is not more useful: WhatsApp invalidates stale device
  sessions anyway, so a 30-day-old backup very likely restores to `logged_out`.
- Restore is untested until it has been tested. Phase 12 includes a restore
  drill.

### 17.3 Rollback

| Scope | Action | Effect |
|---|---|---|
| Disable the feature | Toggle the flag off | Card hidden. Sockets keep running. **Instant, no deploy** |
| Stop the gateway | `docker compose stop whatsapp` | Backend serves `stale: true`. Twilio path untouched — the ERP's existing WhatsApp keeps working |
| Roll back backend/frontend | Existing `rollback.yml` | Unchanged |
| Remove entirely | Stop, remove the service, **keep the volume** | Never `docker volume rm` on a rollback: it destroys sessions and forces a fleet-wide re-scan |

The whole design's rollback property: **stopping the gateway degrades WhatsApp
to exactly what exists today.** No ERP functionality depends on it.

---

## 18. Rate limiting

Three layers, different jobs:

**API** — `@fastify/rate-limit`, Redis-backed, 100 req/min per instance id on
instance-scoped routes. Protects the gateway from a backend bug (a runaway poll
loop), not from an attacker; the attacker cannot reach it.

**Send** (post-MVP) — token bucket per instance, `wa:ratelimit:<instance_id>`:

| Setting | Default | Rationale |
|---|---|---|
| Sustained | 20 msg/min | Comfortably inside human-plausible use |
| Burst | 10 | A batch of session reminders should not queue for 30s |
| Inter-message delay | 1 000–3 000 ms jitter | Fixed-interval sending is a machine signature |
| Daily cap | 1 000/instance | A backstop against a runaway automation |

These are **deliberately conservative**. WhatsApp publishes no rate limit for
Web clients; the numbers are chosen to sit inside plausible human behaviour
rather than to approach an unknown ceiling. They are **not** tuned to evade
detection — see §19.

**Global** — a cap on concurrent instances (`WA_MAX_INSTANCES`, default 50)
and on total outbound across all instances, so one studio cannot exhaust the
process for everyone.

---

## 19. Abuse prevention

**What this service is for:** a gym messaging its own clients — session
reminders, payment receipts, renewal notices, replies to enquiries.

**Not built, and not to be added:**

- ❌ Bulk/broadcast messaging to non-clients
- ❌ Contact scraping or number enumeration
- ❌ Any mechanism to evade WhatsApp rate limits or enforcement
- ❌ Ban-evasion, fingerprint randomisation, proxy rotation, "anti-detection"

The rate limits in §18 exist to keep real usage inside plausible bounds, **not**
to find the edge of what WhatsApp tolerates. Anything framed as "avoiding
detection" is out of scope by design, not by omission.

**Enforced controls:**

| Control | Where | Why there |
|---|---|---|
| Recipient must be an existing client/lead of that org | **Backend** | It has the contacts and the tenant context; the gateway has neither. This is the load-bearing anti-spam control |
| E.164 format validation | Both | Cheap, catches bugs |
| No group JIDs in MVP | Gateway | A group send is a broadcast with extra steps |
| Per-instance daily cap | Gateway | Backstop against a runaway automation loop |
| Opt-out honoured | Backend | A client who replies STOP is flagged and excluded before enqueue |
| Full audit trail | Backend | `communication_logs`, per tenant, already exists |

**In-product disclosure** — before the first QR is shown, the UI states plainly
that this connects a personal/business WhatsApp account, that it is not the
official WhatsApp Business API, and that misuse can get the number banned by
Meta. Consent has to be informed to be consent.

---

## 20. WhatsApp platform limitations

| Limitation | Consequence |
|---|---|
| **This is not an approved integration.** WhatsApp's terms prohibit unauthorised automated clients | The number can be **banned permanently, without warning or appeal**. This is the headline risk and the studio must accept it explicitly |
| Linked-device sessions expire | An inactive session can be invalidated; the phone must come online periodically |
| The primary phone matters | Modern multi-device reduces but does not remove the dependency. A phone offline for a long period can end the session |
| Max ~4 linked devices | A studio already using WhatsApp Web on several machines may hit the cap |
| Protocol changes without notice | Baileys can break on any WhatsApp release. §21.2 |
| No delivery SLA | Nothing to appeal to when messages are delayed or dropped |
| New/low-reputation numbers are throttled hardest | A brand-new number for automation is the highest-risk configuration |
| No template pre-approval | Which is why Cloud API messaging outside the 24-hour window is not available here either |

**This is not a Meta partnership and cannot be represented to studios as one.**

---

## 21. Baileys limitations

### 21.1 Version — the decision

Verified against the npm registry on 2026-09-01:

| | `7.0.0-rc14` | `6.7.24` |
|---|---|---|
| dist-tag | `latest` | `legacy` |
| Published | 2026-07-29 | 2026-07-29 (**same day**) |
| Licence | MIT | MIT |
| `libsignal` | `^6.0.0` from the **registry** | **raw git URL**, unpinned ref |
| HTTP client | none (`axios` dropped) | `axios ^1.6.0` |
| Extra | `whatsapp-rust-bridge@0.5.4` (**WASM**, MIT) | — |
| Node | `>=20` | `>=20` |

**Recommendation: pin `baileys@7.0.0-rc14` exactly.**

Reasoning, including the counter-argument:

- *Against*: it is a release candidate, and the RC line has been running since
  at least rc10. Shipping an RC to production is a real cost.
- *For*: 6.7.24 resolves `libsignal` from a **raw git URL**. That needs `git` in
  the Docker build image, has no registry integrity hash, and — absent a
  lockfile — resolves to whatever that repository's HEAD happens to be. For a
  library implementing the Signal protocol against a hostile network, that is a
  materially worse supply chain than a versioned registry dependency.
- *For*: WhatsApp Web protocol drift punishes staleness. `legacy` is the
  maintainers' own word for that line, and running the branch they have
  labelled legacy against a protocol that changes without notice is its own
  risk — arguably a larger one than the RC label.
- *For*: dropping `axios` removes a dependency and its CVE stream.

Both lines being published the same day means 6.7.24 is genuinely maintained,
so this is a close call rather than an obvious one. **`6.7.24` is the documented
fallback** if Phase 10's real-device test shows rc14 unstable; the pin is one
line and the auth-state format is compatible across the two.

Either way: **exact pin, no caret.** A range on a library that talks an
undocumented protocol means an unattended `npm ci` can change how the service
speaks to WhatsApp.

### 21.2 Upgrade procedure

Never auto-upgrade. Each bump: read the changelog → bump in a branch → CI →
**real-device QR test on a non-production number** → deploy to one studio →
watch for 24h → widen. The version pin is a production configuration change,
not a dependency chore.

### 21.3 Resource profile

Each instance holds a WebSocket, Signal session state, and Baileys' internal
caches. The 1 GB limit in §15.3 is a **placeholder**: no per-instance memory
figure is asserted here because none has been measured on this stack. Phase 9
measures 1, 5 and 10 concurrent instances, and `WA_MAX_INSTANCES` is set from
that measurement rather than from a guess.

### 21.4 Other constraints

- Baileys' API changes across minor versions — the ERP is insulated because it
  only ever sees this service's REST contract.
- Full history sync on first connect can be large, so the MVP sets
  `syncFullHistory: false`.

  > **Corrected in Phase 3.** This bullet originally also called for
  > `shouldSyncHistoryMessage: () => false`. Baileys 7 logs, on every socket
  > where that is set:
  >
  > *"DANGER: DISABLING ALL SYNC BY shouldSyncHistoryMsg PREVENTS BAILEYS FROM
  > ACCESSING INITIAL LID MAPPINGS, LEADING TO INSTABILITY AND SESSION ERRORS"*
  >
  > LID mappings are how Baileys 7 resolves a contact's real identity, so
  > suppressing them trades a little bandwidth for sessions that fail in ways
  > that are hard to diagnose. `syncFullHistory: false` already bounds the
  > volume, which was the actual goal. The override is **not** set.

- **A socket that never connects may produce no event at all.** Discovered in
  Phase 3 by running the service against a network that blocks WhatsApp: the
  WebSocket was refused in under 100 ms and Baileys emitted no
  `connection.update` whatsoever — no QR, no close, no error. The instance sat
  in `connecting` indefinitely.

  Baileys' own `connectTimeoutMs` did not rescue it, so the connector arms its
  own watchdog (`WA_CONNECT_TIMEOUT_MS`, default 45 s), cleared by the first
  QR or `open`. On expiry the instance goes to `failed` with
  `last_error_code: connect_timeout` and emits
  `whatsapp.instance.disconnected`. Without it, the first time the VPS loses
  egress to WhatsApp every studio would watch a spinner forever while the
  backend polled a state that could never change.

- `markOnlineOnConnect` defaults to **true** and is set to **false**. Left on,
  the gateway registers as an active online client and WhatsApp stops pushing
  notifications to the studio owner's own phone — they would silently stop
  hearing from their own clients.

- No official support. The community is the support channel.

- ~~Exact export names must be verified against the installed package.~~
  **Done in Phase 3**, against `baileys@7.0.0-rc14`:
  `makeWASocket`, `DisconnectReason`, `Browsers`, `initAuthCreds`, `BufferJSON`,
  `proto`, `fetchLatestBaileysVersion` and `useMultiFileAuthState` all exist as
  assumed. `useMultiFileAuthState` is **not used** — see §12.4.

---

## 22. Licence considerations

**Verified 2026-09-01 from the npm registry.**

| Package | Licence |
|---|---|
| `baileys` | **MIT** |
| `libsignal` (its Signal-protocol dependency) | **GPL-3.0** |
| `whatsapp-rust-bridge` | MIT |
| `pino`, `ws`, `protobufjs`, `zod`, `fastify` | MIT / BSD-family |

### 22.1 The GPL-3.0 dependency

Baileys is MIT, but it depends on **`libsignal`, which is GPL-3.0** — a strong
copyleft licence. This is the licence question that matters, and it is easy to
miss by reading only Baileys' own badge.

The mechanism, stated factually:

- GPL-3.0 obligations attach on **distribution** — conveying the software to
  another party.
- GPL-3.0 is **not** AGPL-3.0. Running software on your own server and offering
  its functionality over a network is not distribution under GPL-3.0. This is
  the well-known difference AGPL-3.0 was written to close.
- MY PT STUDIO is SaaS: the gateway runs on your VPS and users interact with it
  over the network. On that reading, **the copyleft obligation is not triggered**.

**What this design does to keep it that way** — and this is now a licensing
argument for the separation, not only an architectural one:

1. GPL-3.0 code lives **only** in `619-erp-whatsapp`. It is never imported into
   `619-erp-backend` or `619-erp-frontend`, so those remain unencumbered and
   independently licensable.
2. The boundary is **HTTP between separate processes in separate containers** —
   the clearest form of separation, not in-process linking.
3. If the gateway is ever distributed — shipped on-premise, sold as a
   self-hostable product, delivered as an image to a customer — **the GPL-3.0
   obligations engage** and this analysis must be redone before that happens.

⚠️ **This is an engineering reading of licence text, not legal advice.** Before
this reaches paying customers, have counsel confirm it. Two questions worth
putting to them specifically: (a) does the SaaS reading hold in your
jurisdiction, and (b) does publishing the gateway repository publicly change
anything. The cost of asking is small; the cost of being wrong after acquiring
customers is not.

### 22.2 Repository visibility

`619-erp-backend` and `619-erp-frontend` are **public**. Whatever visibility
this repository takes, the operative rule is unchanged and absolute: **no
secret, no session credential, and no auth state is ever committed.** §7.6 and
`.gitignore` enforce it; CI should also run a secret scan.

---

## 23. Official Meta API vs Baileys

| | **Baileys (this service)** | **Meta WhatsApp Cloud API** | **Twilio (in place today)** |
|---|---|---|---|
| Sanctioned by Meta | ❌ No | ✅ Yes | ✅ Yes (BSP) |
| Ban risk | **High — permanent, no appeal** | None if compliant | None if compliant |
| Setup for the studio | **Scan a QR (~30s)** | Business verification, days–weeks | Twilio account + number |
| Per-message cost | **₹0** | Per-conversation | Per-message + Twilio margin |
| Uses the studio's own number | ✅ **Yes** | Number must be migrated & verified | ❌ Platform number |
| Free-form outside 24h | ✅ Yes | ❌ Approved templates only | ❌ Templates |
| Receive messages | ✅ Yes | ✅ Yes | ✅ Yes |
| Reliability | Best-effort | SLA | SLA |
| Breaks on protocol change | ✅ Yes | ❌ No | ❌ No |
| Per-tenant | ✅ Yes, by design | Per-tenant, heavy onboarding | ❌ **Platform-wide today** |

### 23.1 Why Baileys, honestly

The brief's requirement is that a studio owner connects WhatsApp by scanning a
QR, with no tokens, no Meta app, no business verification. **Only a WhatsApp Web
client can deliver that experience.** The Cloud API's onboarding — business
verification, number migration, template approval — is precisely the friction
the requirement exists to remove.

So this is not "Baileys is better". It is: the desired UX and the official API
are mutually exclusive, and the UX was chosen with the risk stated.

### 23.2 The recommended end state

```
WhatsApp provider (per organization)
├── SelfHostedBaileysProvider   ← this service. Fast onboarding, ban risk
├── TwilioProvider              ← EXISTS. Platform-wide, compliant, costs money
└── MetaCloudProvider           ← future. Per-tenant, compliant, heavy onboarding
```

Studios choose knowingly: zero-friction with real risk, or verified and
compliant with real friction. Building the seam (§9.2) now means the third
option is an addition rather than a rewrite — but **only the seam** is built in
the MVP. The `MetaCloudProvider` is not speculatively implemented.

### 23.3 Twilio's disposition — decided

**Optional, explicitly-selected provider. Code untouched.**

Not deprecated (it works, it is tested, it is the only compliant path today).
Not the default (it is platform-wide; the whole point here is per-tenant).
**Not a fallback** — §9.3: falling back would send a client a message from a
number they do not recognise.

`whatsappDelivery.js` is not edited. It gains a caller, not a rewrite.

---

## Appendix A. API contract

All routes require `X-Gateway-Key`. All responses are JSON.
Errors: `{ "error": { "code": "…", "message": "…" } }`.

### MVP

| Method | Path | Body / Notes | Success |
|---|---|---|---|
| `POST` | `/v1/instances` | `{ instance_id: uuid, organization_id: uuid }` — the **backend** supplies both, so ids are stable across a gateway volume loss | `201 { instance_id, state }` |
| `GET` | `/v1/instances` | Optional `?organization_id=` filter | `200 { instances: [...] }` |
| `GET` | `/v1/instances/:id` | | `200 { instance }` |
| `GET` | `/v1/instances/:id/qr` | | `200 { qr, expires_in_ms }` · `410 QR_EXPIRED` · `409` if connected |
| `GET` | `/v1/instances/:id/status` | | `200 { state, phone_e164, connected_at, last_error_code }` |
| `POST` | `/v1/instances/:id/reconnect` | Resets the attempt counter | `202 { state: 'connecting' }` |
| `POST` | `/v1/instances/:id/disconnect` | Closes the socket, **keeps** creds | `202 { state: 'disconnected' }` |
| `DELETE` | `/v1/instances/:id` | Logs out, **destroys** creds | `204` |
| `GET` | `/healthz` `/readyz` | No auth | §14.3 |

Every instance-scoped route requires `X-Org-Id` and asserts ownership before
doing anything (§2, §6.2). `disconnect` vs `DELETE` is a deliberate distinction:
one is "pause, no rescan needed", the other is "unlink, rescan required".

### Post-MVP (defined, not built)

`POST /v1/instances/:id/messages` · `POST …/media` · `GET …/chats` · `GET …/messages`

### Backend surface (frontend-facing)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/integrations/whatsapp/status` | Merges DB row + live gateway status |
| `POST` | `/api/integrations/whatsapp/connect` | Creates the instance, starts pairing |
| `GET` | `/api/integrations/whatsapp/qr` | Proxies the QR; polled at 2s |
| `POST` | `/api/integrations/whatsapp/reconnect` | |
| `POST` | `/api/integrations/whatsapp/disconnect` | |
| `DELETE` | `/api/integrations/whatsapp` | Full unlink |
| `POST` | `/api/webhooks/whatsapp` | Gateway → backend. HMAC-verified, mounted **before** `express.json()` |

⚠️ Adding these changes the frontend's `api-shape.test.ts` snapshot of all 462
endpoints. It must be updated in the same commit, deliberately.

---

## Appendix B. Event schema

```jsonc
{
  "schema_version": 1,
  "event_id":   "uuid v4",         // idempotency key
  "event_type": "whatsapp.instance.connected",
  "instance_id":"uuid",
  "tenant_id":  "uuid",            // organization_id
  "occurred_at":"ISO-8601 UTC",
  "payload":    { }
}
```

| `event_type` | `payload` |
|---|---|
| `whatsapp.instance.created` | `{}` |
| `whatsapp.instance.qr` | `{ expires_at, round }` — **no QR string** (§8.3) |
| `whatsapp.instance.connecting` | `{ attempt }` |
| `whatsapp.instance.connected` | `{ phone_e164, platform, connected_at }` |
| `whatsapp.instance.disconnected` | `{ reason_code, will_retry, next_retry_at }` |
| `whatsapp.instance.logged_out` | `{ reason_code }` |
| `whatsapp.instance.deleted` | `{}` |
| `whatsapp.message.*` *(post-MVP)* | `{ message_id, direction, to_e164 \| from_e164, status, … }` |

---

## Appendix C. ERP schema changes

Migration **`185_whatsapp_instances.sql`** — proposed, **not yet written**.

```sql
CREATE TABLE IF NOT EXISTS whatsapp_instances (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id      UUID NOT NULL UNIQUE,
  status           TEXT NOT NULL DEFAULT 'never_connected'
                   CHECK (status IN ('never_connected','connecting','connected',
                                     'disconnected','reconnecting','logged_out',
                                     'qr_timeout','failed')),
  phone_e164       TEXT,
  last_error_code  TEXT,
  connected_at     TIMESTAMPTZ,
  disconnected_at  TIMESTAMPTZ,
  last_event_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One instance per studio in the MVP (§6.3). Dropping this later is a
  -- migration, not a redesign, because instance_id is already its own column.
  CONSTRAINT whatsapp_instances_one_per_org UNIQUE (organization_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_instances_org
  ON whatsapp_instances (organization_id);

-- Webhook idempotency ledger (§7.3). At-least-once delivery makes duplicates
-- normal, so this is load-bearing, not defensive.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  event_id         UUID PRIMARY KEY,
  event_type       TEXT NOT NULL,
  organization_id  UUID REFERENCES organizations(id) ON DELETE CASCADE,
  instance_id      UUID,
  occurred_at      TIMESTAMPTZ NOT NULL,
  received_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_events_received
  ON whatsapp_webhook_events (received_at DESC);

-- Then re-run migration 157/158's RLS discovery block. It loops over every
-- table carrying organization_id and attaches the tenant_isolation policy, so
-- both tables above are covered WITHOUT a hand-written policy that could
-- drift out of sync with the others.
```

Post-MVP, one column:

```sql
ALTER TABLE communication_logs ADD COLUMN IF NOT EXISTS provider TEXT;  -- 'twilio' | 'baileys'
```

**Not created:** `whatsapp_messages` (use `communication_logs`, §12.2) ·
`whatsapp_contacts` (use `pt_clients.whatsapp`) · `whatsapp_events`
(the ledger above covers idempotency; a full event archive has no reader yet).

---

## Appendix D. Environment variables

### Gateway

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `NODE_ENV` | — | |
| `LOG_LEVEL` | `info` | Never `debug` in production — §7.6 |
| **`WA_GATEWAY_KEY`** | — | **Required.** ≥32 bytes. Process refuses to start without it |
| **`WA_WEBHOOK_SECRET`** | — | **Required.** HMAC key for outbound events |
| `WA_BACKEND_URL` | — | **Required.** `http://myptstudio-backend:5000`. The only outbound host |
| `REDIS_URL` | `redis://redis:6379` | Hard dependency — §11.4 |
| `WA_SESSION_DIR` | `/data/sessions` | On the volume |
| `WA_MAX_INSTANCES` | `50` | Set from Phase 9 measurement, not this default |
| `WA_QR_TTL_SEC` | `60` | |
| `WA_QR_MAX_ROUNDS` | `5` | |
| `WA_CONNECT_TIMEOUT_MS` | `45000` | Watchdog for a socket that produces no event at all — see §21.4. Added in Phase 3 |
| `WA_CONNECTOR` | `baileys` | `null` runs the service with pairing inert. This is what rollout step 5 in §16.2 needs |
| `WA_RECONNECT_BASE_MS` | `2000` | |
| `WA_RECONNECT_MAX_MS` | `300000` | |
| `WA_RECONNECT_MAX_ATTEMPTS` | `10` | |
| `WA_QUARANTINE_RETENTION_DAYS` | `7` | |
| `WA_SESSION_ENC_KEY` | *(unset)* | Optional — [open decision](#appendix-e-open-decisions) |

### Backend (new)

| Variable | Notes |
|---|---|
| `WA_GATEWAY_URL` | `http://myptstudio-whatsapp:8080` |
| `WA_GATEWAY_KEY` | **Must match the gateway's** |
| `WA_WEBHOOK_SECRET` | **Must match the gateway's** |
| `WA_GATEWAY_TIMEOUT_MS` | Default `10000` |

Existing `TWILIO_*` variables are **unchanged and still used** (§23.3).

---

## Appendix E. Open decisions

Carried into Phase 2 with a recommendation each, so none of them silently
becomes a default.

| # | Decision | Recommendation |
|---|---|---|
| 1 | Encrypt session state at rest? | **Deferred to after Phase 10**, not done in Phase 4. The condition this entry set for itself — "once the happy path is proven" — is not met: no real phone has scanned a QR yet. Adding a crypto layer beneath an unproven pairing path means debugging two unknowns at once when Phase 10 first fails, and a lost `WA_SESSION_ENC_KEY` forces a fleet-wide re-scan. §17.2's encrypted off-box backups already cover the realistic leak path (a stolen backup tarball) in the meantime |
| 2 | `baileys@7.0.0-rc14` or `6.7.24`? | **rc14**, pinned exactly. §21.1 — and it is a close call, not an obvious one |
| 3 | Repository visibility | **Private**, unless there is a reason otherwise. No secrets either way |
| 4 | Encrypted off-box session backups | **Yes** — `age` + off-box, 7 daily. §17.2 |
| 5 | If the gateway must ever be publicly exposed | Then `X-Gateway-Key` alone is insufficient: mTLS or signed requests. Revisit §7.2 |
| 6 | `WA_MAX_INSTANCES` value | Measure in Phase 9. Do not ship the placeholder `50` untested |

---

## Change log

| Date | Change |
|---|---|
| 2026-09-01 | Phase 1 initial design, from the Phase 0 audit. Baileys version, licence, and dependency facts verified against the npm registry the same day |
