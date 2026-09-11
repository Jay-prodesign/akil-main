# RUNTIME-001: Node-runtime deployment candidate.
#
# This builds and runs the compiled kernel locally/in a container. It is
# scaffolding only - no image is built, pushed, or run against a live
# registry/host by this checkpoint (no CI step references this file yet;
# see .github/workflows/ci.yml, which runs build+test only).
#
# Config is supplied entirely through environment variables consumed by
# src/runtime/app-config.ts (PORT, DEPLOYMENT_ENV, PERSISTENCE_DRIVER,
# DATABASE_URL) - no credential or account value is baked into this file.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 8080
CMD ["node", "dist/src/runtime/node-server-entrypoint.js"]
