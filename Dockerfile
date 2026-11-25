# Overtime as a long-running container (cron-like loop) for people who prefer not to run it
# as a GitHub Action. dist/cli.cjs is a single bundled file with no runtime dependencies.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5

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
