FROM node:20-alpine

# Patch OS packages (openssl, libcrypto3, etc.) dan hapus npm/yarn/corepack
# karena server.cjs sudah fully standalone dan tidak butuh npm di runtime
RUN apk --no-cache upgrade && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/corepack /opt/yarn*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=5050

# server.cjs sudah fully bundled (esbuild bawaan) berisi semua dependensi backend
COPY server.cjs ./server.cjs
COPY public ./public
COPY userscript ./userscript

EXPOSE 5050

CMD ["node", "server.cjs"]

