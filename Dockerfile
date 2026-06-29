# syntax=docker/dockerfile:1

# BeanyCord — Discord OTP bot. Built to lean JS (no tsx/esbuild at runtime).
# DES-based OTP decrypt needs OpenSSL's legacy provider → NODE_OPTIONS below.
ARG NODE_VERSION=20

FROM node:${NODE_VERSION}-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# --- build: install ALL deps + compile TS → dist/ -------------------------
FROM base AS build
# Need devDependencies (typescript) for the build step
ENV NODE_ENV=development
# build toolchain for better-sqlite3 if no prebuilt binary is available
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- prod-deps: production-only node_modules (incl. native better-sqlite3) -
FROM base AS prod-deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: minimal image ----------------------------------------------
FROM base AS runtime
# Required: OpenSSL 3 disables single-DES by default; OTP decrypt needs it.
ENV NODE_OPTIONS=--openssl-legacy-provider
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# /data is a mounted Fly volume at runtime (SESSION_DB_PATH points there).
CMD ["node", "dist/index.js"]
