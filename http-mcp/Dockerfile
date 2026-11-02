# DACS ChatGPT plugin container. Build from the http-mcp/ directory:
#   docker build -t dacs-chatgpt-plugin:1.0.0 .
# No secrets are baked in; provide configuration via the runtime environment.
FROM node:22.22.0-bookworm-slim

ENV NODE_ENV=production \
    DACS_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8787

WORKDIR /app
COPY package.json package-lock.json ./
COPY vendor/ ./vendor/
# Reproducible install from the lockfile; lifecycle scripts disabled.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY bin/ ./bin/
COPY src/ ./src/
COPY public/ ./public/
COPY skills/ ./skills/
COPY plugin.json mcp.json ./

RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "bin/dacs-chatgpt-plugin.mjs"]
