# The lint container (src/server.ts) for the RelayRunner Checks App. The API's LintRunner Durable
# Object starts it without internet access and streams the repo in, so nothing here downloads at
# lint time: every tool is installed below. Node runs the server's TypeScript directly.
FROM node:24-bookworm-slim

ARG ACTIONLINT_VERSION=1.7.7
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl python3-pip shellcheck; \
  pip3 install --no-cache-dir --break-system-packages ruff zizmor typos; \
  npm install -g --no-fund --no-audit oxlint oxfmt; \
  npm cache clean --force; \
  curl -fsSL "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin actionlint; \
  apt-get purge -y curl; \
  apt-get autoremove -y; \
  rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY src/ ./src/
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
