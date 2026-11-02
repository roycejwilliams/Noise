FROM node:20-alpine
WORKDIR /app
# Chromium for reading pages a plain fetch is turned away from
# (api/src/services/browserRead.ts, 2026-09-30).
RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont
# ffmpeg turns an iMessage voice memo (audio/x-caf) into mp3 for OpenAI's transcription, which doesn't take CAF
# (api/src/services/openaiAudio.ts, 2026-11-02).
RUN apk add --no-cache ffmpeg
ENV CHROMIUM_PATH=/usr/bin/chromium-browser
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
CMD ["node", "dist/server.js"]