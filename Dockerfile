# 619-erp-whatsapp — production image (architecture §15.1)
#
# ── Why bookworm-slim and not Alpine ────────────────────────────────────────
#
# The ERP's backend image is node:20-bookworm-slim, and matching it means one
# glibc to reason about across the stack rather than two. Baileys 7's Rust
# dependency is WebAssembly, not a native addon — no `os`/`cpu` fields and no
# platform-specific optional packages — so it needs no build toolchain and no
# musl variant. Verified against the installed package, not assumed.

# ── build: compile TypeScript ───────────────────────────────────────────────
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` and not `npm install`: the lockfile is the input, and a build that
# can silently resolve a different tree is a build whose output nobody can
# reproduce. Dev dependencies are needed here because tsc is one.
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── deps: production node_modules only ──────────────────────────────────────
#
# A separate stage from `build` so the runtime image never receives typescript,
# vitest, eslint and their transitive trees. Measured on this lockfile:
#
#     npm ci --omit=dev   ->  added 134 packages
#     npm ci              ->  added 296 packages
#
# So 162 packages that exist only to build and test never reach the running
# container — and every one of them would otherwise be CVE surface in a service
# that holds WhatsApp credentials and talks to a hostile network.
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runner
WORKDIR /app

# Non-root. The session volume holds WhatsApp credentials — full account access
# for every connected studio — so the process that reads them should not also
# be able to rewrite the filesystem it runs on.
#
# /data is created and chowned HERE, at build time. Docker gives a named volume
# the ownership of the image's mount point on first attach, so without this the
# volume would land root-owned and the non-root process could not write its
# session state. That failure appears much later, as a `saveCreds` error on the
# very first pairing.
RUN groupadd --system --gid 1001 nodejs \
 && useradd  --system --uid 1001 --gid nodejs --home /app wa \
 && mkdir -p /data/sessions /data/quarantine \
 && chown -R wa:nodejs /data \
 && chmod 700 /data

COPY --from=deps  --chown=wa:nodejs /app/node_modules ./node_modules
COPY --from=build --chown=wa:nodejs /app/dist        ./dist
# server.ts reads `version` out of this at boot for its startup log.
COPY --chown=wa:nodejs package.json ./

USER wa

ENV NODE_ENV=production \
    PORT=8080 \
    WA_SESSION_DIR=/data/sessions \
    WA_MANIFEST_PATH=/data/instances.json \
    WA_QUARANTINE_DIR=/data/quarantine

# Documentation only. The compose file publishes NO host port for this service
# (§16.1) — it is reachable on the Docker network and nowhere else.
EXPOSE 8080

# Liveness, not readiness. /healthz deliberately touches nothing external: a
# liveness probe that fails during a Redis outage would restart-loop a healthy
# process and drop every live WhatsApp socket on each restart, turning a
# dependency blip into an outage of its own. /readyz is the one that reports
# dependencies, and it is for an operator, not for Docker.
#
# `node -e` with global fetch rather than curl: bookworm-slim ships no curl, and
# adding a package to a production image to run a health check is a poor trade.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No tini / dumb-init. Node 20 installs its own SIGTERM handler and server.ts
# uses it for the ordered teardown in §15.2 — an init shim would add a process
# that forwards the signal and nothing else.
CMD ["node", "dist/server.js"]
