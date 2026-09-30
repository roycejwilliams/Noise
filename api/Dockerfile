FROM node:20-alpine
WORKDIR /app
# Chromium for reading pages a plain fetch is turned away from
# (api/src/services/browserRead.ts, 2026-09-30).
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]