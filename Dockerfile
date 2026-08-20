# Discord Bot Manager Dockerfile
# Uses Docker-in-Docker to manage bot containers
#
# Multi-stage build: npm install + tsc run natively on the build host,
# only the final image is multi-platform. This avoids slow QEMU emulation
# for arm64 builds in CI.

# Stage 1: Build (runs natively on the CI runner's architecture)
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (native speed, no QEMU)
RUN npm install

# Copy source code
COPY . .

# Build TypeScript + copy static assets (the build script handles both)
RUN npm run build

# Stage 2: Runtime (built for each target platform)
FROM node:20-alpine

# Install Docker CLI (to communicate with host Docker). docker-cli-buildx
# provides BuildKit support, required to build Dockerfiles that use
# `RUN --mount=...`; without it those builds fall back to the legacy builder
# and fail. openssl generates the fleet database's pinned replication certs
# (the postgres:16-alpine sidecar has no openssl CLI of its own).
RUN apk add --no-cache docker-cli docker-cli-buildx docker-cli-compose git openssl

# Trust any repository we operate on (bind-mounted source repos may have
# mismatched UIDs after CasaOS post-deploy chown). Scoped to this image only.
RUN git config --global --add safe.directory '*'

WORKDIR /app

# Copy package files and install production dependencies only
COPY package*.json ./
RUN npm install --omit=dev

# Copy built artifacts from builder stage
COPY --from=builder /app/dist ./dist

# Create data directory
RUN mkdir -p /data/data/bots

# Expose port
EXPOSE 8080

# Set environment variables
ENV NODE_ENV=production
ENV DATA_DIR=/data/data
ENV PORT=8080

# Start the application
CMD ["npm", "start"]
