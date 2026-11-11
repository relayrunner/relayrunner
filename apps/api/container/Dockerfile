# The runner image for container runners (src/durable-objects/container-runner.ts). It's GitHub's
# official runner image, which runs as the `runner` user in /home/runner. The container starts with
# a one-job JIT config in RUNNER_JIT_CONFIG, takes one job and exits, which stops the container.
# The version is pinned so the image only rebuilds when it changes (scripts/deploy.ts tags images by
# their contents). Dependabot opens a PR for each runner release, which matters: GitHub stops
# sending jobs to old runner versions. Merging one rebuilds the image on that deploy.
FROM ghcr.io/actions/actions-runner:2.338.2

# Node and the lint tools come preinstalled, so a lint job doesn't spend most of its time
# downloading them. Node goes in the tool cache where `actions/setup-node` looks first, so
# `node-version: 24` is a cache hit, and on PATH for jobs that skip setup-node.
ARG NODE_MAJOR=24
ENV RUNNER_TOOL_CACHE=/opt/hostedtoolcache
USER root
RUN set -eu; \
  version="$(curl -fsSL https://nodejs.org/dist/index.json | jq -r --arg m "v${NODE_MAJOR}." 'map(select(.version | startswith($m))) | .[0].version | ltrimstr("v")')"; \
  dir="$RUNNER_TOOL_CACHE/node/$version/x64"; \
  mkdir -p "$dir"; \
  curl -fsSL "https://nodejs.org/dist/v$version/node-v$version-linux-x64.tar.gz" | tar -xz --strip-components=1 -C "$dir"; \
  touch "$dir.complete"; \
  ln -s "$dir/bin/node" "$dir/bin/npm" "$dir/bin/npx" /usr/local/bin/; \
  PATH="$dir/bin:$PATH" npm install -g --no-fund --no-audit pnpm oxlint oxfmt; \
  for tool in pnpm oxlint oxfmt; do ln -s "$dir/bin/$tool" /usr/local/bin/; done; \
  npm cache clean --force; \
  chown -R runner:runner "$RUNNER_TOOL_CACHE"
USER runner

CMD ["/bin/sh", "-c", "exec ./run.sh --jitconfig \"$RUNNER_JIT_CONFIG\""]
