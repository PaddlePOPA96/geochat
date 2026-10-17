# Base builder stage
FROM node:20-slim AS builder

WORKDIR /app

# 1. Cache dependensi: Hanya install ulang jika package.json/package-lock.json berubah
COPY package*.json ./
RUN npm ci

# 2. Salin source code & lakukan build bundle
COPY . .
RUN npm run build

# Production runtime stage (sangat ringan, tanpa devDependencies seperti electron/vite)
FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=2121

# Install dependensi runtime saja (express, socket.io, youtube-chat, tiktok-live, better-sqlite3)
COPY package*.json ./
RUN npm ci --omit=dev

# Ambil hasil compile server & file publik dari builder
COPY --from=builder /app/server.cjs ./server.cjs
COPY --from=builder /app/public ./public

EXPOSE 2121

CMD ["node", "server.cjs"]
