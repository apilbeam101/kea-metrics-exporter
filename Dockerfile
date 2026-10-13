# syntax=docker/dockerfile:1

# The dependency and build stages run on the build host's own platform: they
# produce architecture-independent JavaScript, which holds because
# scripts/check-no-native-addons.ts keeps every runtime dependency pure JS.
# Only the runtime stage has to match the requested --platform.
FROM --platform=$BUILDPLATFORM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM --platform=$BUILDPLATFORM node:24-slim AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build

FROM node:24-slim AS runtime

ARG GIT_COMMIT=unknown
ARG IMAGE_VERSION=0.0.0

LABEL org.opencontainers.image.title="kea-metrics-exporter" \
      org.opencontainers.image.description="Prometheus exporter for ISC Kea DHCP, including high-availability state" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      org.opencontainers.image.revision="${GIT_COMMIT}"

ENV GIT_COMMIT=${GIT_COMMIT} \
    NODE_ENV=production

# A fixed non-root UID/GID, so Kubernetes runAsUser and compose or systemd
# user mappings can target a known value.
RUN groupadd --system --gid 10001 exporter \
    && useradd --system --uid 10001 --gid exporter --no-create-home --shell /usr/sbin/nologin exporter

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

USER exporter:exporter

EXPOSE 10167

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

# Exec form, so Node is PID 1 and receives SIGTERM directly.
ENTRYPOINT ["node", "dist/index.js"]
