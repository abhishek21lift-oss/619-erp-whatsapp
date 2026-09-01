# 619-erp-whatsapp

Self-hosted WhatsApp gateway for **MY PT STUDIO / 619 Fitness ERP**.

Lets a studio connect its own WhatsApp number by scanning a QR code in
Settings → Integrations → WhatsApp — no Meta access token, no API key, no
third-party provider account.

> ⚠️ **This is not the official WhatsApp Cloud API.** It is a WhatsApp **Web**
> client built on [Baileys](https://github.com/WhiskeySockets/Baileys). It is
> not sanctioned by Meta, and a connected number **can be banned permanently,
> without warning or appeal**. Read
> [§20–§23 of the architecture](docs/WHATSAPP-ARCHITECTURE.md#20-whatsapp-platform-limitations)
> before pointing this at a real studio's phone number.

---

## Status

**Phase 1 — design complete. No service code yet.**

| Phase | State |
|---|---|
| 0 — Audit of `619-erp-frontend` / `619-erp-backend` | ✅ Done |
| 1 — Architecture, API contract, security design | ✅ This commit |
| 2 — Service skeleton | ⬜ Not started |
| 3–5 — Baileys pairing, session persistence, lifecycle | ⬜ |
| 6–8 — Backend ↔ gateway auth, ERP integration, UI | ⬜ |
| 9–13 — Tests, real QR test, Docker, VPS, production | ⬜ |

## Read this first

**[`docs/WHATSAPP-ARCHITECTURE.md`](docs/WHATSAPP-ARCHITECTURE.md)** — the
complete design: topology, QR pairing, session lifecycle, tenant isolation,
security model, event schema, failure handling, Docker, deployment, and the
platform/licence risks.

## Where it sits

```
619-erp-frontend  ──HTTPS──▶  619-erp-backend  ──internal──▶  619-erp-whatsapp
                              (business authority)            (this repo)
                                                                    │
                                                              Baileys ──▶ WhatsApp
```

Three properties the design depends on:

- **No public port.** The gateway is reachable only from the backend, on the
  Docker network. There is no nginx vhost and no TLS certificate for it.
- **No database credentials.** Session state lives on a private volume; QR and
  the event outbox live in Redis. The ERP database is the backend's alone.
- **Never reached by a browser.** The backend is the only permitted caller.

## Tenancy

One WhatsApp instance belongs to exactly one studio (`organization_id`).
Ownership is asserted on every instance-scoped operation, and the organization
id is always derived by the backend from the authenticated session — never read
from a request body, query string, or client-supplied header.

## Licence note

Baileys is MIT, but its `libsignal` dependency is **GPL-3.0**. Keeping this
gateway in its own repository and its own container is what keeps that copyleft
out of the ERP codebase. See
[§22](docs/WHATSAPP-ARCHITECTURE.md#22-licence-considerations) — including the
caveat that it is an engineering reading, not legal advice.
