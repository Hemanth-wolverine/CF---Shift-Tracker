# ---- build stage: install deps (better-sqlite3 is a native module) ----
FROM node:22-bookworm-slim AS build
WORKDIR /app

# Build tools are only needed if a prebuilt better-sqlite3 binary can't be downloaded.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_FILE=/data/tracker.db
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js db.js ./
COPY public ./public

# The SQLite database lives in /data, which is mounted as a volume.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
