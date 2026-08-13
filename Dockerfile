# Multi-architecture digest for the official node:22.23.2-bookworm-slim image.
# Update the tag and digest together after reviewing a new runtime release.
FROM node:22.23.2-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run web:build

FROM base AS production-dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/.node-version ./.node-version
COPY --from=build --chown=node:node /app/scripts/check-runtime.mjs /app/scripts/check-operator-runtime.mjs /app/scripts/start-production.mjs ./scripts/
COPY --from=build --chown=node:node /app/db ./db
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/web/lib ./web/lib
COPY --from=build --chown=node:node /app/web/scripts ./web/scripts

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "scripts/start-production.mjs"]
