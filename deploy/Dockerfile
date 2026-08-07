# ---------- stage 1: build the two front-ends ----------
FROM node:20-bookworm-slim AS web

WORKDIR /build

# Admin panel
COPY admin/package.json admin/package-lock.json* admin/
RUN cd admin && npm ci --no-audit --no-fund
COPY admin/ admin/
RUN cd admin && npm run build

# ---------- stage 2: runtime ----------
FROM node:20-bookworm-slim

# LibreOffice is kept in the image for the one-off archive importer, which accepts
# Office documents. The HTTP upload path is PDF-only and does not use it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc \
        fonts-dejavu fonts-liberation \
        ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8080 \
    ADMIN_DIST=/app/admin/dist \
    HOME=/tmp

WORKDIR /app

COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server/ ./
COPY --from=web /build/admin/dist ./admin/dist

RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
