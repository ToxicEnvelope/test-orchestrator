# Setup/RunnerCI/Dockerfile
# ------------------------------------------------------------
# Runner image for TestOrchestrator as a Container Apps Job.
#
# Builds TypeScript -> dist/, prunes dev deps, and runs once:
#   node dist/job/main.js
# ------------------------------------------------------------
ARG BASE_IMAGE=test-automation.azurecr.io/test-orchestrator-base:latest

# ---- build stage (tsc + dev deps) ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json ./
# If you ever decide to add it later, you can uncomment:
# COPY package-lock.json ./

COPY tsconfig.json ./
COPY src ./src

# Install dependencies (dev deps included for build)
RUN npm install

# Compile TypeScript
RUN npm run build

# Remove dev dependencies to keep runtime small
RUN npm prune --omit=dev

# ---- runtime stage (plain Node runtime from Golden image) ----
FROM ${BASE_IMAGE} AS runtime
WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# Container Apps Job executes this once per run (then container exits)

CMD ["node", "dist/src/job/main.js"]
