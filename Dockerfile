FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=2121

# server.cjs sudah fully bundled (esbuild bawaan) berisi semua dependensi backend
COPY server.cjs ./server.cjs
COPY public ./public
COPY userscript ./userscript

EXPOSE 2121

CMD ["node", "server.cjs"]
