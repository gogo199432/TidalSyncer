FROM oven/bun:1.3-alpine

WORKDIR /app

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
