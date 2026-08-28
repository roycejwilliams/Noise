# Build context is the repository root (Railway "Root Directory" must be left
# unset / at the repo root for this service — see /railway.toml at the repo root).
# co-test is the QA/tester dashboard only now (2026-08-27 consolidation) — the
# real product backend (call handling, text handling, cron jobs) lives in
# api/src and is never duplicated here. co-test still imports select shared
# modules straight from api/src rather than copying them (DB pool, the
# profile-extraction pipeline, callContext/callContext-adjacent helpers the
# dashboard's own /api/assess-coverage sandbox route still uses, etc.), so
# both directories need to be in the build context. api/'s own node_modules
# ARE installed even though only api/src is copied in: Node module resolution
# only walks *ancestor* directories from the importing file, and
# api/src/services/profileExtraction.ts is not a descendant of co-test/, so
# co-test/node_modules alone can't satisfy its imports (pg, openai,
# @ai-sdk/anthropic, ai) — confirmed by a failed build before this was added.
# co-test's own remaining product-adjacent code (services/mediaStreamBridge.ts,
# callTrigger.ts) is deliberately kept — it still backs the dashboard's own
# real "place a test call" button (routes/phone.ts), separate from api's now
# equivalent production capability.
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
