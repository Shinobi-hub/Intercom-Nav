# Ride server + built PWA in one image. Voice runs on LiveKit (Cloud or self-hosted), configured via env.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --no-audit --no-fund --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STATIC_DIR=/app/apps/web/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY e2e/package.json e2e/
RUN npm ci --omit=dev --workspace @intercom/server --include-workspace-root=false --no-audit --no-fund --ignore-scripts
COPY --from=build /app/apps/server/dist apps/server/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8787
CMD ["node", "apps/server/dist/index.js"]
