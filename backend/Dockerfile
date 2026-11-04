# Relstate backend container. Generic on purpose: this image is the same whether it runs on
# Fly.io or a plain Hetzner VPS (`docker run`), see docs/deploy.md.
#
# Build from the REPO ROOT, not from backend/, because the app's tracked IDL copy (app/idl/) has
# to be in the build context:
#   docker build -f backend/Dockerfile -t relstate-backend .
#
# No secrets are baked in. Every secret (FEE_PAYER_KEYPAIR, TREASURY_KEYPAIR, ...) is injected at
# runtime as an environment variable (`fly secrets set`, or `docker run -e`/`--env-file`).
FROM node:22-slim

# Native TS, no build step: Node 22.18+ strips `backend/src/*.ts` at load time (package.json
# `engines`), so there is nothing to compile here -- only production dependencies to install.
#
# The same goes for the database: `backend/src/store.ts` uses the runtime's own `node:sqlite`, which
# needs no flag from Node 22.13 on (verified on 22.18 and 26), so there is nothing to add to CMD and
# no native module to build. The database file itself lives on the mounted volume, named by
# DATABASE_PATH -- `/data/relstate.db` on Fly -- which the `node` user below has to be able to
# write, exactly as it already writes UPLOADS_DIR.
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend \
    && npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY backend/src ./backend/src
# The tracked IDL copy (scripts/sync-idl.sh), so backend/src/layout.ts has real account layouts in
# a container that never runs `anchor build`. RELSTATE_IDL below points at it.
COPY app/idl ./app/idl

ENV NODE_ENV=production \
    PORT=8787 \
    RELSTATE_IDL=/app/app/idl/relstate.json

WORKDIR /app/backend
EXPOSE 8787

# Runs as the image's existing non-root `node` user (uid 1000), after the files above were written
# as root -- chown once, then drop privileges for everything that follows, including CMD.
RUN chown -R node:node /app
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.ts"]
