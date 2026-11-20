# The Blacksmith container (src/server.ts). The API's BlacksmithCli Durable Object starts it to read
# a workspace's Blacksmith usage with the org token the workspace connected. It needs internet
# access to reach Blacksmith's API.
#
# Blacksmith's CLI is pinned to one release from its own host and checked against the SHA-256 that
# host publishes (https://clireleases.blacksmith.sh/cli/<version>/linux/amd64/blacksmith.sha256),
# so the image only rebuilds when the version changes (apps/api/scripts/deploy.ts tags images by
# their contents). Auto-update is off: a new CLI version only runs after someone bumps it here.
FROM node:24-bookworm-slim

ARG BLACKSMITH_VERSION=v0.5.3
ARG BLACKSMITH_SHA256=089a301ea5cc93a7560c7f1106911547fdfd46fc5c0cef7079e2a62a22e971ce
RUN set -eu; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl; \
  curl -fsSL -o /usr/local/bin/blacksmith \
    "https://clireleases.blacksmith.sh/cli/${BLACKSMITH_VERSION}/linux/amd64/blacksmith"; \
  echo "${BLACKSMITH_SHA256}  /usr/local/bin/blacksmith" | sha256sum -c -; \
  chmod 755 /usr/local/bin/blacksmith; \
  apt-get purge -y curl; \
  apt-get autoremove -y; \
  rm -rf /var/lib/apt/lists/*
ENV BLACKSMITH_DISABLE_AUTO_UPDATE=1

WORKDIR /app
COPY src/ ./src/
USER node
EXPOSE 8080
CMD ["node", "src/server.ts"]
