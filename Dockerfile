# Build stage
FROM node:22-slim AS build

RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && \
    npm prune --omit=dev && \
    apt-get purge -y --auto-remove python3 make g++ && \
    rm -rf /root/.npm /tmp/*

# Production stage
FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash appuser

WORKDIR /app

COPY --from=build --chown=appuser:appuser /app/node_modules ./node_modules
COPY --from=build --chown=appuser:appuser /app/package.json ./
COPY --from=build --chown=appuser:appuser /app/frontend-dist ./frontend-dist
COPY --from=build --chown=appuser:appuser /app/deploy ./deploy
COPY --from=build --chown=appuser:appuser /app/functions ./functions

ENV NODE_ENV=production
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/ || exit 1

USER appuser
CMD ["node", "--import", "./deploy/server/register.mjs", "deploy/server/index.js"]
