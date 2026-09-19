# Bun, not Node: the code imports `bun:sqlite` (wallet + whale persistence),
# which Node cannot load. `node dist/cli.js` crashes at startup.
FROM oven/bun:1-alpine

WORKDIR /app

COPY package.json tsconfig.json vitest.config.ts ./
COPY src ./src
COPY config.yaml ./config.yaml
COPY README.md ./README.md

RUN bun install --frozen-lockfile || bun install
RUN bun run build

ENV NODE_ENV=production

# Dashboard stays on loopback unless DASHBOARD_HOST *and* DASHBOARD_TOKEN are
# both set — see DashboardServer.start().
CMD ["bun", "run", "dist/cli.js", "start", "--config", "config.yaml"]
