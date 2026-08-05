FROM oven/bun:1.3-alpine

WORKDIR /app

# `download` lifts the FLAC stream out of the MP4 container TIDAL serves it in, with
# `-c copy` — no transcoding, so this is only ever a demux. Without it the lossless tiers
# fail outright and only the AAC ones work; `sync` and `export` do not need it at all.
RUN apk add --no-cache ffmpeg

# Install dependencies first so code changes do not invalidate the dependency layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# Credentials, sync state and the lookup cache live here; mount a volume over it.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R bun:bun /data

USER bun
VOLUME ["/data"]

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["daemon"]
