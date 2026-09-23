# syntax=docker/dockerfile:1
# Super-Logs: one small image, one process, one SQLite volume.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/node/package.json packages/node/
COPY packages/browser/package.json packages/browser/
COPY apps/server/package.json apps/server/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @super-logs/shared -w @super-logs/dashboard -w @super-logs/server

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    SUPER_LOGS_DATA_DIR=/data \
    SUPER_LOGS_DASHBOARD_DIR=/app/dashboard
WORKDIR /app
# The server is bundled into a single file, so the runtime image needs no
# package manifests, no lockfile and no node_modules at all: just Node, one
# script and the dashboard's static assets.
COPY --from=build /app/apps/server/dist/index.js ./index.js
COPY --from=build /app/apps/server/dist/index.js.map ./index.js.map
COPY --from=build /app/apps/dashboard/dist ./dashboard

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1
ARG SUPER_LOGS_VERSION=dev
ENV SUPER_LOGS_VERSION=$SUPER_LOGS_VERSION
# node:sqlite still prints an ExperimentalWarning on Node 24; it is stable enough for us.
CMD ["node", "--disable-warning=ExperimentalWarning", "index.js"]
