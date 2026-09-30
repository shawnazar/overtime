# Overtime as a long-running container (cron-like loop) for people who prefer not to run it
# as a GitHub Action. dist/cli.cjs is a single bundled file with no runtime dependencies.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

LABEL org.opencontainers.image.title="overtime" \
      org.opencontainers.image.description="Billing-aware runs-on routing: GitHub-hosted until included minutes run out, then self-hosted" \
      org.opencontainers.image.source="https://github.com/shawnazar/overtime" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY dist/cli.cjs /app/cli.cjs

# The node image ships an unprivileged "node" user; nothing here needs root.
USER node
ENV NODE_ENV=production
ENTRYPOINT ["node", "/app/cli.cjs"]
CMD ["--interval", "10m"]
