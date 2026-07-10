# Build context is the repository root (Railway "Root Directory" must be left
# unset / at the repo root for this service — see /railway.toml at the repo root).
# co-test imports its Hume config, DB pool, and extraction pipeline straight
# from api/src rather than duplicating them, so both directories need to be in
# the build context. Only api/src (no node_modules, no unrelated api routes
# get executed) is copied in — matching, circles, moments, sendblue, cron jobs
# etc. are never imported by anything co-test runs.
FROM node:20-alpine
WORKDIR /app

COPY co-test/package*.json ./co-test/
RUN npm --prefix co-test install

COPY api/src ./api/src
COPY co-test ./co-test

WORKDIR /app/co-test
RUN npm run build

CMD ["node", "dist/co-test/src/server.js"]
