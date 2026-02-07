# Setup/GoldenCI/Dockerfile
# Base image for TestOrchestrator when running as a Container Apps Job.
# RunnerCI will copy app build artifacts and define the command to execute the orchestrator.
FROM node:20-bookworm-slim

USER root

# Avoid interactive prompts during apt installs (tzdata)
ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Etc/UTC \
    NODE_ENV=production

# Minimal OS tools (keep only what you truly need at runtime)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tzdata \
    git \
    jq \
    dumb-init \
    azure-cli \
  && ln -snf /usr/share/zoneinfo/$TZ /etc/localtime \
  && echo $TZ > /etc/timezone \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app