# Overtime as a long-running container (cron-like loop) for people who prefer not to run it
# as a GitHub Action. dist/cli.cjs is a single bundled file with no runtime dependencies.
FROM node:26-alpine@sha256:0b36e8c136b94cd4fcf02188228e76c31ad5872eef3fec8cbd2eee500cfd9e80

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
