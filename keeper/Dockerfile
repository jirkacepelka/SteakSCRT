# The keeper, as a long-running container.
#
# No build step: the source is TypeScript run directly through Node's type stripping, so
# what runs is what you can read in `src/`. That matters more here than a few megabytes —
# anyone can check the thing holding a hot key against the repository without trusting a
# compiler output.
FROM node:22-alpine

# Never root. The process needs outbound HTTPS and nothing else: no ports, no volumes, no
# filesystem writes.
USER node
WORKDIR /keeper

COPY --chown=node:node keeper/package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

COPY --chown=node:node keeper/src ./src
COPY --chown=node:node keeper/tsconfig.json ./tsconfig.json

# Report the invariants and exit non-zero if the protocol looks wrong, so an orchestrator
# can tell "running" from "running and healthy".
HEALTHCHECK --interval=10m --timeout=60s --start-period=1m \
  CMD node --experimental-strip-types src/index.ts --check-only || exit 1

CMD ["node", "--experimental-strip-types", "src/index.ts"]
