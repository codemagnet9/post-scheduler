# Dockerfile — one image, two roles (web / worker), selected by the command.
# Debian (bookworm), NOT Alpine, on purpose:
#   - ffmpeg/ffprobe come from apt: platform-native, security-patched, and matched to the glibc the
#     process runs on. We deliberately do NOT use the ffmpeg-static / ffprobe-static npm packages
#     (unpatched vendored binaries, larger, and a supply-chain surface we don't control).
#   - sharp ships prebuilt glibc binaries; on Alpine (musl) it would recompile libvips from source.
FROM node:22-bookworm-slim AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

# --- dependencies (cached unless the lockfile changes) ---
COPY package.json package-lock.json ./
# Runtime deps only. tsx runs the TypeScript directly (no compile step in this repo); it is a
# devDependency, so install it explicitly rather than pulling in vitest/eslint/etc.
RUN npm ci --omit=dev \
 && npm install --no-save tsx@4.19.2 \
 && npm cache clean --force

COPY . .

# Non-root.
RUN useradd --system --uid 1001 --home /app meridian && chown -R meridian /app
USER meridian
EXPOSE 3000

# dumb-init reaps zombies and forwards signals so graphile-worker shuts down cleanly (finishes the
# in-flight publish, releases its lease) instead of being SIGKILLed mid-attempt.
ENTRYPOINT ["dumb-init", "--"]
# Overridden per role: web = server.ts, worker = worker.ts, migrate = scripts/migrate.ts.
CMD ["npx", "tsx", "src/server.ts"]
