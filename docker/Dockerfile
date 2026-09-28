# syntax=docker/dockerfile:1
#
# Pacific Ocean Portal: Next.js viewer, built as a standalone server.
# The survey data is NOT in the image; docker-compose mounts it read-only.
# Build from the project root:  docker compose -f docker/docker-compose.yml build

# --- dependencies (postinstall copies the Cesium runtime and laz-perf wasm into public/)
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY scripts/copy-cesium.mjs scripts/copy-lazperf-wasm.mjs ./scripts/
RUN npm ci --no-audit --no-fund

# --- build
FROM node:22-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
COPY --from=deps /app/public ./public
# The Cesium ion token ships in the browser bundle by design, so it is a build argument.
ARG NEXT_PUBLIC_CESIUM_ION_TOKEN
ENV NEXT_PUBLIC_CESIUM_ION_TOKEN=${NEXT_PUBLIC_CESIUM_ION_TOKEN}
RUN npm run build

# --- runtime: only the standalone server, as an unprivileged user
FROM node:22-alpine AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data
RUN addgroup -S -g 1001 app && adduser -S -u 1001 -G app app \
 && mkdir -p /data && chown app:app /data
COPY --from=build --chown=app:app /app/.next/standalone ./
COPY --from=build --chown=app:app /app/.next/static ./.next/static
COPY --from=build --chown=app:app /app/public ./public
USER app
EXPOSE 3000
CMD ["node", "server.js"]
