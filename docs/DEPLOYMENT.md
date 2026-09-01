# Deploying the WhatsApp gateway

Operator runbook for `619-erp-whatsapp` on the MY PT STUDIO VPS.

> **Two things to read before you start.**
>
> 1. **The image in this repository has never been built.** See §1.
> 2. **No pairing has ever succeeded.** `docs/TESTING.md` §1 explains why, and
>    §4 there is the manual test that has to pass before any real studio is
>    pointed at this. Deploying is not the same as verifying.

---

## 0. What you are deploying, and what it does not change

A fourth container beside the three that already run. It is **additive**:
nothing in the existing deployment is modified by installing it, and the ERP
runs exactly as it does today if the container is absent, stopped, or broken.

| | |
|---|---|
| Reachable from | the `myptstudio-backend` container only, over the Docker network |
| Published host ports | **none** |
| nginx vhost | **none** |
| Public DNS name | **none** |
| Existing Twilio path | **untouched** — still the delivery route the workers use |

The backend treats the gateway as optional. With `WA_GATEWAY_URL` unset, the
WhatsApp card in Settings → Integrations reports "not set up on this server"
and every other integration behaves as before. **That is the rollback state**
(§11), and it is one environment variable away at all times.

---

## 1. The image has not been built — start here

The build environment this service was written in cannot reach Docker Hub:

```
$ docker pull node:20-bookworm-slim
error: production.cloudfront.docker.com:443 — gateway answered 403 to CONNECT (policy denial)
```

So `docker build` has **never run** against this `Dockerfile`. Every claim in it
was verified another way — `npm ci --omit=dev` produces a tree the built
`dist/server.js` boots on, the `HEALTHCHECK` command exits 0 healthy and 1
unhealthy, and the service runs as uid 1001 against a `0700` `/data` and answers
`/readyz` — but a Dockerfile that has never been built is a Dockerfile with an
unknown syntax error in it until proven otherwise.

**Build it first, on its own, and read the output** before touching compose:

```bash
cd /opt/myptstudio/619-erp-whatsapp
docker build -t wa-gateway-test .
```

Then prove the two things the build cannot:

```bash
# 1. It boots. FAILING here is the EXPECTED result — it proves config
#    validation runs. A container that starts happily with no secrets is a bug.
docker run --rm wa-gateway-test
#    expect: exit non-zero, naming ALL THREE missing values at once —
#    WA_GATEWAY_KEY, WA_WEBHOOK_SECRET, WA_BACKEND_URL — not just the first.
#    Reporting them one per restart is what src/config.ts exists to avoid.

# 2. The health check works and the process is non-root.
docker run -d --name wa-probe \
  -e WA_GATEWAY_KEY=$(openssl rand -hex 32) \
  -e WA_WEBHOOK_SECRET=$(openssl rand -hex 32) \
  -e WA_BACKEND_URL=http://127.0.0.1:1 \
  -e WA_CONNECTOR=null \
  wa-gateway-test
sleep 25
docker inspect --format '{{.State.Health.Status}}' wa-probe   # expect: healthy
docker exec wa-probe id                                        # expect: uid=1001(wa)
docker rm -f wa-probe
```

`WA_CONNECTOR=null` runs the whole service — auth, tenancy, manifest, events —
with pairing inert, so this probe cannot touch WhatsApp. `/readyz` will report
`redis: false` without a Redis, which is correct and is why the `HEALTHCHECK`
probes `/healthz` and not `/readyz` (§6).

Only once all of that passes is §2 worth doing.

---

## 2. Installing it on the box

The compose file that actually serves production lives at
**`/opt/myptstudio/docker-compose.yml`**, outside every repository.
`619-erp-backend/.github/workflows/deploy.yml` runs `docker compose build
backend` and `up -d backend` against it over SSH.

**Nothing in this repository edits that file, and nothing here should.** The
steps below are manual on purpose.

### 2.1 Clone the gateway beside the other two

```bash
cd /opt/myptstudio
git clone git@github.com:abhishek21lift-oss/619-erp-whatsapp.git
# Until the MVP branch merges, that is what you want — `main` does not yet
# carry the gateway.
git -C 619-erp-whatsapp checkout feature/whatsapp-gateway-mvp
```

### 2.2 Check the names before pasting anything

```bash
docker compose -f /opt/myptstudio/docker-compose.yml config --services
```

`deploy/compose.whatsapp.yml` assumes the Redis service is called `redis` and
that the backend answers on `myptstudio-backend:5000` — the hostname
`619-erp-backend/.env.example` already documents. **If the names on the box
differ, change the fragment to match the box.** Renaming a service that already
works, to suit a service that has never run, is the wrong direction.

### 2.3 Paste the service in

Copy the `whatsapp:` block from `deploy/compose.whatsapp.yml` into the
`services:` map of `/opt/myptstudio/docker-compose.yml`, and the
`whatsapp-sessions:` entry into its `volumes:` map.

The service is `whatsapp` and its `container_name` is `myptstudio-whatsapp`,
matching the box's existing convention (`backend` / `myptstudio-backend`). The
fragment also declares `myptstudio-whatsapp` as a network alias, so the hostname
the backend resolves does not depend on Docker's container-name DNS behaviour —
which could not be tested in the build environment. Keep both. The service name
is only what you type.

The alias assumes the box's services sit on compose's implicit `default`
network. If `/opt/myptstudio/docker-compose.yml` declares a named network,
change `default:` in the fragment to match it, or this container lands on a
different network and cannot reach `redis` or the backend at all.

Pasting rather than overlaying with `-f`: `deploy.yml` and `rollback.yml` both
invoke a bare `docker compose`, so an overlay file is invisible to them unless
`COMPOSE_FILE` is exported in every shell and every CI-driven SSH session. One
missed shell and the gateway silently stops being part of the deployment. The
fragment's header covers both routes.

Check the merge before starting anything:

```bash
cd /opt/myptstudio
docker compose config > /dev/null && echo OK
```

### 2.4 Generate the secrets

```bash
openssl rand -hex 32   # WA_GATEWAY_KEY
openssl rand -hex 32   # WA_WEBHOOK_SECRET
```

Append them to `/opt/myptstudio/.env` — **once**, because the same two values are
read by both the gateway and the backend. A drifted pair is the failure mode
§3.3 describes, and it is the one that fails quietly.

```
WA_GATEWAY_KEY=<the first value>
WA_WEBHOOK_SECRET=<the second value>
```

Then confirm the file is not readable by anyone else:

```bash
chmod 600 /opt/myptstudio/.env
```

### 2.5 Start it

```bash
cd /opt/myptstudio
docker compose build whatsapp
docker compose up -d whatsapp
docker compose ps whatsapp        # expect: running (healthy)
docker compose logs --tail 50 whatsapp
```

Expect `gateway_listening` and `instances_restored` with `restored: 0` on a
first start. **Nothing has been exposed to any studio yet** — the backend still
has no `WA_GATEWAY_URL`.

### 2.6 Only now, wire the backend to it

Add to `/opt/myptstudio/.env`:

```
WA_GATEWAY_URL=http://myptstudio-whatsapp:8080
WA_GATEWAY_TIMEOUT_MS=10000
```

and add these four variables to the `backend` service's `environment:` map,
alongside the ones already there:

```yaml
      WA_GATEWAY_URL: ${WA_GATEWAY_URL:-}
      WA_GATEWAY_KEY: ${WA_GATEWAY_KEY:-}
      WA_WEBHOOK_SECRET: ${WA_WEBHOOK_SECRET:-}
      WA_GATEWAY_TIMEOUT_MS: ${WA_GATEWAY_TIMEOUT_MS:-10000}
```

`:-` and not `:?` on these four, unlike on the gateway's own two: the backend
must keep starting when the gateway is not part of a deployment, which is the
whole point of §0.

Apply the migration and restart the backend:

```bash
docker compose run --rm --no-deps backend npm run migrate
docker compose up -d backend
```

The migration (`185_whatsapp_instances.sql`) is additive — two new tables, no
change to an existing one.

The card in Settings → Integrations should now read **Not connected** rather
than "not set up on this server". That is the end of deployment and the
beginning of `docs/TESTING.md` §4.

---

## 3. Environment variables

### 3.1 On the gateway

| Variable | Required | Default | Notes |
|---|---|---|---|
| `WA_GATEWAY_KEY` | **yes** | — | Authenticates backend → gateway. Must match the backend. Process refuses to start without it, min 32 chars |
| `WA_WEBHOOK_SECRET` | **yes** | — | HMAC key for gateway → backend. Must match the backend. Same refusal |
| `WA_BACKEND_URL` | **yes** | — | The **only** host this service ever calls outbound. Fixed config so no caller-supplied URL is ever fetched |
| `REDIS_URL` | no | `redis://redis:6379` | **Hard** dependency here, unlike in the ERP |
| `PORT` / `HOST` | no | `8080` / `0.0.0.0` | `0.0.0.0` with no published port is not an exposure |
| `LOG_LEVEL` | no | `info` | **Never `debug` in production** — see §7 |
| `WA_SESSION_DIR` | no | `/data/sessions` | On the volume |
| `WA_MANIFEST_PATH` | no | `/data/instances.json` | On the volume |
| `WA_QUARANTINE_DIR` | no | `/data/quarantine` | On the volume |
| `WA_MAX_INSTANCES` | no | `50` | **Untested** — §12 |
| `WA_QR_TTL_SEC` | no | `60` | |
| `WA_QR_MAX_ROUNDS` | no | `5` | |
| `WA_CONNECT_TIMEOUT_MS` | no | `45000` | Watchdog for a socket that emits no event at all |
| `WA_CONNECTOR` | no | `baileys` | `null` = everything runs, pairing inert |

### 3.2 On the backend

| Variable | Required | Effect if unset |
|---|---|---|
| `WA_GATEWAY_URL` | no | Card reports "not set up on this server"; nothing else changes |
| `WA_GATEWAY_KEY` | no | Same — both are needed for the integration to report configured |
| `WA_WEBHOOK_SECRET` | no | Webhook rejects everything; connection state stops updating |
| `WA_GATEWAY_TIMEOUT_MS` | no | 10000 |

### 3.3 The rule that matters

`WA_GATEWAY_KEY` and `WA_WEBHOOK_SECRET` are shared secrets. **One value each,
set once in `/opt/myptstudio/.env`, read by both services.** Setting them per
service is how they drift — and a drifted `WA_WEBHOOK_SECRET` fails silently in
the direction that hurts: the gateway keeps pairing, the backend rejects every
event, and the card sits on a stale state while WhatsApp is actually connected.

**Rotating either** means restarting both services together. There is no
rolling rotation; the window between the two restarts is a window where the
hop is broken. Do it when nobody is pairing.

---

## 4. Persistent volumes

One volume, `whatsapp-sessions`, mounted at `/data`.

| Path | Contents | Rebuildable? |
|---|---|---|
| `/data/sessions/<instance-id>/` | Baileys auth state: device identity, Signal identity keys, pre-keys, app-state sync keys | **No** |
| `/data/instances.json` | The instance manifest: which org owns which instance | No |
| `/data/quarantine/` | Session directories moved aside after a failed integrity check | n/a |

**`/data/sessions` is full WhatsApp account access for every linked studio.**
Treat it as you would a private key file, because that is what it contains.

Two consequences:

- **Named volume, not a bind mount.** The image creates `/data` owned by uid
  1001 at build time, and Docker copies that ownership onto a named volume on
  first attach. A host bind mount arrives root-owned instead, and the non-root
  process then fails its first `saveCreds` — which surfaces much later, during
  somebody's first pairing.
- **Losing it is not silent, and not recoverable.** Every studio has to re-scan.
  The backend's `whatsapp_instances` row still says they are linked, so the
  mismatch is visible to them before it is visible to you.

---

## 5. Reverse proxy and HTTPS

**There is nothing to configure. That is the design, not an omission.**

The gateway publishes no host port and has no nginx vhost. Its only caller is
the backend container, over the Docker network. That network boundary is the
primary access control; the `X-Gateway-Key` header is the second, and it is the
whole credential on that hop — which is acceptable *only* because of the first.

So:

- Do **not** add a `server` block for it in `infra/nginx/`.
- Do **not** add a `ports:` entry, **including `127.0.0.1:8080:8080`**. A
  loopback publish still exposes the gateway to every other process on the box
  and to anything that can reach the host's loopback, behind nothing but a
  shared header value.
- Do **not** give it a DNS name.

The studio-facing surface is already HTTPS: browser → nginx (`myptstudio.com`,
Let's Encrypt) → frontend → backend → gateway. The last hop is plaintext HTTP
inside the Docker bridge and is meant to be — TLS between two containers on one
host protects against an attacker who is already on the host, at which point
`/data` is readable anyway.

To reach it for debugging, use the container, never a port:

```bash
docker compose exec whatsapp \
  node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.json()).then(console.log)"
```

---

## 6. Health checks

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /healthz` | none | **Liveness.** Is the process alive |
| `GET /readyz` | none | **Readiness.** Redis, session dir writable, manifest loaded |
| `GET /metrics` | `X-Gateway-Key` | Counters (§10) |

The image's `HEALTHCHECK` probes `/healthz`, **not** `/readyz`, and the
difference is deliberate: a liveness probe that failed during a Redis outage
would restart-loop a healthy process and drop every live WhatsApp socket on each
restart — turning a dependency blip into an outage of its own, and producing
exactly the connect/disconnect pattern that looks like abuse from Meta's side.
`/readyz` is for an operator, not for Docker.

```bash
# Liveness, as Docker sees it
docker compose ps whatsapp

# Readiness, in full
docker compose exec whatsapp \
  node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.json()).then(o=>console.log(JSON.stringify(o,null,2)))"
```

A healthy readiness response:

```json
{ "status": "ready",
  "checks": { "redis": true, "session_dir_writable": true, "manifest_loaded": true } }
```

`session_dir_writable: false` is the one to act on immediately — it means a
volume mounted read-only or owned by the wrong uid, and the next pairing will
lose its credentials.

---

## 7. Logs

Structured JSON via pino, to stdout, rotated by the compose fragment at
5 × 10 MB. Rotation is set here and not on the other services because this one
reconnects on a backoff loop whenever WhatsApp is unreachable: an outage lasting
a weekend writes steadily, Docker's `json-file` driver is unbounded by default,
and the failure mode is the host disk filling — which takes the API down with it.

```bash
docker compose logs -f whatsapp
docker compose logs --since 1h whatsapp | grep '"level":50'   # errors only
```

Lines worth knowing:

| Event | Means |
|---|---|
| `gateway_listening` | Started |
| `instances_restored` | Sessions reloaded from `/data` after a restart. `restored` should equal the number of linked studios |
| `socket_opened` | A WhatsApp socket is up. `restored: true` means no QR was needed |
| `qr_available` | A pairing code was issued |
| `instance_logged_out` | The phone unlinked this device. **The gateway must not retry** |
| `creds_restored_from_backup` | Primary creds file was unreadable; the backup was used. Not fatal, but investigate the disk |
| `creds_save_failed` | **Act now.** Credentials are not being persisted; the next restart loses the session |
| `outbox_reclaimed_stale` | The sweeper picked up an event a dying process abandoned. Working as designed |
| `gateway_shutting_down` → `gateway_stopped` | Clean teardown, in order |
| `gateway_shutdown_timeout` | Teardown exceeded 25s and was forced. Sockets may have been dropped uncleanly |

**`LOG_LEVEL=debug` is not a diagnostic step here.** It enables Baileys protocol
logging, which is a far wider surface than the redaction deny-list in
`src/logger.ts` can promise to cover, and what it would emit is session
material. If you genuinely need it, do it on a throwaway number, never on a
studio's.

---

## 8. Restarting

```bash
docker compose restart whatsapp
```

**Every linked studio's WhatsApp connection drops and re-establishes.** No QR is
required — sessions are restored from `/data` — and `docs/TESTING.md` §4.3 is
the check that proves it. If a QR *does* appear after a plain restart, stop:
session persistence is broken, and that is a §11 problem, not a retry.

`stop_grace_period: 30s` against a 25s internal budget. Do not shorten it. A
SIGKILL partway through teardown leaves WhatsApp sockets vanishing mid-session
instead of closing, and that is a risk to a studio's phone number.

After a `docker compose up -d` that rebuilds the image, confirm the count:

```bash
docker compose logs whatsapp | grep instances_restored
```

`restored` below the number of linked studios means some session did not come
back. Find out which before anyone reports it.

---

## 9. Backup

### 9.1 What to back up

The `whatsapp-sessions` volume, and nothing else in this service. Everything else is
rebuilt from the image or from Redis.

```bash
docker run --rm \
  -v myptstudio_whatsapp-sessions:/data:ro \
  -v /opt/myptstudio/backups:/backup \
  alpine tar czf /backup/wa-sessions-$(date +%F-%H%M).tar.gz -C /data .
```

Check the volume's real name first — compose prefixes it with the project
directory: `docker volume ls | grep whatsapp-sessions`.

### 9.2 Treat the backup as a credential

**That tarball is every linked studio's WhatsApp account.** Four rules, from
architecture §17.2, and none of them is optional:

**Encrypt it at rest.** An unencrypted tarball on the same box is a second copy
of the crown jewels with none of the volume's `0700` protection — it is strictly
worse than the thing it is protecting.

```bash
chmod 600 /opt/myptstudio/backups/wa-sessions-*.tar.gz
age -r <recipient> -o /opt/myptstudio/backups/wa-sessions-$(date +%F).tar.gz.age \
                      /opt/myptstudio/backups/wa-sessions-$(date +%F)*.tar.gz
shred -u /opt/myptstudio/backups/wa-sessions-$(date +%F)*.tar.gz
```

(`gpg --encrypt` is equally fine. What is not fine is skipping this step.)

**Keep it off-box**, or it does not survive the failure it exists for. Wherever
the database backups go, with the same access controls — not in the repo, not in
object storage without encryption, not in anyone's home directory.

**Retain 7 daily, and no more.** Longer is not more useful: WhatsApp invalidates
stale device sessions, so a 30-day-old backup very likely restores to
`logged_out` (§9.3). Every extra copy is another place the credentials live.

**Restore it once before you rely on it** (§9.3). An untested backup is not a
backup, and the moment you need it is the wrong moment to find that out.

### 9.3 Restoring

```bash
docker compose stop whatsapp
docker run --rm -v myptstudio_whatsapp-sessions:/data -v /opt/myptstudio/backups:/backup \
  alpine sh -c "rm -rf /data/* && tar xzf /backup/<file>.tar.gz -C /data"
docker compose start whatsapp
```

Then confirm `instances_restored` matches, and that no studio is presented with
a QR.

**A restored session may be stale.** If WhatsApp invalidated the credentials
while the backup sat on disk — because the phone unlinked the device, or Meta
expired it — the restore produces a session that pairs and then logs out. That
is not a failure of the restore; it means that studio re-scans.

---

## 10. Monitoring

```bash
docker compose exec whatsapp sh -c \
  'node -e "fetch(\"http://127.0.0.1:8080/metrics\",{headers:{\"X-Gateway-Key\":process.env.WA_GATEWAY_KEY}}).then(r=>r.json()).then(o=>console.log(JSON.stringify(o,null,2)))"'
```

| Counter | Watch for |
|---|---|
| `instances_total` / `instances_live` | `live` below `total` for more than a few minutes means studios are disconnected and not recovering |
| `instances_capacity` | Approaching `WA_MAX_INSTANCES` — see §12 before raising it |
| `outbox_pending` | Should hover near 0. Sustained growth means the backend is not accepting webhooks |
| `outbox_processing` | Should be 0 or 1. Persistently higher means deliveries are stalling |
| `outbox_retrying` | **The leading indicator.** A rising retry backlog precedes every dead-letter |
| `outbox_dead` | **Page on any non-zero value.** Each one is a state change the ERP never received, and it will not be retried |

### 10.1 Redis is shared, and its budget is not

The gateway namespaces every key under `wa:` (`wa:outbox`, `wa:qr:<id>`,
`wa:lock:<id>`, …), so there is no collision with BullMQ's `bull:` keys. But
they share one Redis, configured `maxmemory 256mb` with **`maxmemory-policy
noeviction`** — chosen so BullMQ is told a write failed rather than having job
hashes silently evicted.

The consequence for this service: `wa:outbox:dead` is never trimmed by design —
a dead-lettered event is evidence, and deleting evidence to save memory is the
wrong trade. It is small, but it is unbounded, and if it ever grows large enough
to matter it will do so at the expense of the *queue*, not of itself. Watch
`outbox_dead`, drain it deliberately, and check Redis memory alongside it:

```bash
docker compose exec redis redis-cli info memory | grep used_memory_human
docker compose exec redis redis-cli llen wa:outbox:dead
```

### 10.2 What no counter will tell you

None of these go non-zero when WhatsApp bans a studio's number. That arrives as
`instance_logged_out` in the log and as **Signed out on the phone** on the card,
and it is indistinguishable from the studio unlinking the device themselves. Ask
before assuming.

---

## 11. Rollback

Four levels, cheapest first. **Level 1 is one variable and takes seconds** — reach
for it before debugging anything under load.

### Level 1 — Turn the integration off, keep everything

Comment out `WA_GATEWAY_URL` in `/opt/myptstudio/.env`, then:

```bash
docker compose up -d backend
```

The card reverts to "not set up on this server". The gateway keeps running and
keeps its sessions; nothing is lost; the existing Twilio path is unaffected
because it never went through here. Reversible by uncommenting.

> **There is no per-studio WhatsApp switch.** Architecture §16.3 planned one and
> it was not built — the mount uses `requireFeature('integrations')`, the shared
> flag governing *every* integration, so turning it off for one studio would
> take their other integrations with it. This level is therefore
> **deployment-wide**: it disables WhatsApp for every studio at once.
>
> In practice that is rarely the constraint it sounds like. An instance exists
> only once a studio presses **Connect**, so during Phase 10 exactly one studio
> has anything to roll back. If you reach a point where you need to disable one
> studio out of many, that is the signal to add the WhatsApp-specific feature
> key §16.3 describes — not to reach for this.

### Level 2 — Stop the gateway, keep the volume

```bash
docker compose stop whatsapp
```

Studios show a stale connected state until the backend's next status call fails,
then the card marks it **last known**. Sessions survive on the volume; starting
it again restores them without a QR.

### Level 3 — Roll the gateway back to a previous commit

```bash
cd /opt/myptstudio/619-erp-whatsapp
git fetch origin main
git checkout --detach <sha>
cd /opt/myptstudio
docker compose build whatsapp
docker compose up -d whatsapp
```

The checkout is now **detached**, exactly as `619-erp-backend/rollback.yml`
warns for the backend: a later `git pull origin main` will not move a detached
HEAD, so run `git checkout main` once main carries the fix, or the next update
silently no-ops.

Note there is **no gateway equivalent of `deploy.yml`** — this repo has no
deploy workflow, by design, and updating it is a deliberate manual act.

### Level 4 — Remove it entirely

```bash
docker compose stop whatsapp
docker compose rm -f whatsapp
# delete the whatsapp service block from /opt/myptstudio/docker-compose.yml
```

**Back up `whatsapp-sessions` first (§9), and do not delete the volume.** Deleting it
means every studio re-scans if the service ever comes back.

`185_whatsapp_instances.sql` **stays applied**. Migrations here are
forward-only, the two tables it adds are additive, and nothing else reads them.
Dropping them would delete the record of which studios were linked.

### 11.1 Which level for which symptom

| Symptom | Level |
|---|---|
| Card shows an error, ERP otherwise fine | 1 |
| Gateway using unexpected memory or CPU | 2, then investigate |
| A studio's number is restricted or banned | **Not a rollback level.** Unlink *that instance* (`DELETE /v1/instances/:id`, or **Unlink** on their card) so the gateway stops presenting credentials Meta has flagged, then `docs/TESTING.md` §4.4. Level 1 would disable every studio to fix one |
| Backend rejecting every webhook (`outbox_retrying` climbing) | Check the secrets match (§3.3) before rolling anything back |
| A QR is demanded after a plain restart | 2 — **do not restart again.** Session persistence is broken and each restart risks another pairing |
| Bad gateway release | 3 |

---

## 12. Two settings that are not validated

Both are guards against runaway, **not** capacity figures, and both are pinned to
the same missing measurement.

| Setting | Value | Why it is not trustworthy |
|---|---|---|
| `WA_MAX_INSTANCES` | 50 | `docs/TESTING.md` §6 measured per-instance RSS only for instances that **never connected**, because the build environment cannot reach WhatsApp. A live session additionally holds Signal session state, app-state sync keys, the LID mapping store and message caches — which is where the memory actually goes |
| `mem_limit` | 1g | Hitting it kills the container. Deliberately **not** derived from the measurement — see below |

The `mem_limit` trade is deliberate. An OOM-killed gateway restarts and restores
every session from `/data` **without a new QR** — recoverable, and only WhatsApp
is affected. An unbounded gateway that exhausts the box lets the kernel pick the
victim, and on a VPS this size that is as likely to be the API as the gateway.

**Why 1g and not ~512m.** 2.5× the largest measured RSS (182 MB at 10 instances)
would suggest about 512m, and that is the wrong arithmetic on the wrong number:
all ten of those instances were *unconnected*, so the figure is a floor. Sizing
a kill threshold from a floor is how you discover the real number by OOM-killing
a studio mid-pairing. 1g is architecture §15.3's value and leaves headroom for
the live-session state the measurement never saw.

**Re-measure both against connected sessions during Phase 10, before onboarding
studios past single digits.** Setting a production capacity limit from a number
taken on a host that cannot reach WhatsApp is exactly the false confidence
`docs/TESTING.md` §1 warns about.

---

## 13. Before the first real studio

In order. Each one has failed for a reason that the previous one would not have
caught.

- [ ] `docker build` succeeds and the §1 probes pass
- [ ] `docker compose config` on the box parses with the gateway pasted in
- [ ] `WA_GATEWAY_KEY` and `WA_WEBHOOK_SECRET` set **once** in `.env`, `chmod 600`
- [ ] `docker compose ps` reports **healthy**
- [ ] `/readyz` returns all three checks `true`
- [ ] `185_whatsapp_instances.sql` applied
- [ ] Card reads **Not connected**, not "not set up on this server"
- [ ] `docker compose config | grep -A40 '^  whatsapp:' | grep -c 'published'` returns **0**
- [ ] Reachable from the backend, and **only** from there:
      ```bash
      docker compose exec backend node -e \
        "fetch('http://myptstudio-whatsapp:8080/healthz').then(r=>console.log(r.status))"   # 200
      curl -sS --max-time 5 http://<the box's public IP>:8080/healthz                        # must FAIL
      ```
- [ ] A backup of `whatsapp-sessions` has been taken **and restored once** (§9.3) — an
      untested backup is not a backup
- [ ] **`docs/TESTING.md` §4 has been completed on a number the studio is
      willing to lose**, including the restart-persistence check in §4.3

The last box is the one that matters. Everything above it can pass on a service
that cannot pair at all.
