# Build context is the repository root (Railway "Root Directory" must be left
# unset / at the repo root for this service — see /railway.toml at the repo root).
# co-test imports its Hume config, DB pool, and extraction pipeline straight
# from api/src rather than duplicating them, so both directories need to be in
# the build context. Only api/src (no api routes/jobs get executed — matching,
# circles, moments, sendblue, cron jobs are never imported by anything co-test
# runs) is copied in, but api/'s own node_modules ARE installed: Node module
# resolution only walks *ancestor* directories from the importing file, and
# api/src/services/profileExtraction.ts is not a descendant of co-test/, so
# co-test/node_modules alone can't satisfy its imports (pg, openai,
# @ai-sdk/anthropic, ai) — confirmed by a failed build before this was added.
FROM node:20-alpine
WORKDIR /app

COPY co-test/package*.json ./co-test/
RUN npm --prefix co-test install

COPY api/package*.json ./api/
RUN npm --prefix api install

COPY api/src ./api/src
COPY co-test ./co-test

WORKDIR /app/co-test
RUN npm run build

CMD ["node", "dist/co-test/src/server.js"]
