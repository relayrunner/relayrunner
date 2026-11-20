# @relayrunner/blacksmith-cli

The container that reads a workspace's Blacksmith usage with Blacksmith's own CLI, and the protocol the API uses to talk to it.

Blacksmith has no public usage API. Its CLI does have `blacksmith usage` and `blacksmith jobs list`, and an organization token (`blacksmith org-token create`, made by an org admin on their own machine) lets it read the whole organization. A workspace connects that token in Settings › Providers or with `relayrunner blacksmith connect`. The API stores it encrypted, like every provider token.

The API's `BlacksmithCli` Durable Object (one per workspace) starts this container (a Cloudflare Container, `lite`, with internet access), POSTs one request to `/run`, and stops the container once it answers. For each request the server:

1. Makes a fresh home directory.
2. Logs in with `blacksmith auth login --api-token - --non-interactive --organization <org>`, with the token on stdin.
3. Runs `blacksmith usage` for the window, one row per day, and pages through `blacksmith jobs list` back to the window's start.
4. Deletes the home directory, and answers with Blacksmith's JSON unparsed.

The API's adapter (`apps/api/src/provider-billing/blacksmith.ts`) reads that JSON.

## Rules

- Only the read commands in `src/commands.ts` ever run, whatever the request says. Never add `jobs logs`, `testbox`, `cache` or `stickydisk` commands: an org token can do more than read.
- The token only goes to the CLI on stdin, and is scrubbed from any output that comes back in an error.
- The CLI is pinned in the `Dockerfile` and checked against the SHA-256 Blacksmith publishes. Auto-update is off. To move to a new version, change `BLACKSMITH_VERSION` and `BLACKSMITH_SHA256` and check that the fixtures in `apps/api/src/provider-billing/fixtures/` still match its output.
- Never ship the Blacksmith binary in anything we hand to customers. It only runs here, in our own container.

## Files

- `src/protocol.ts` (exported as `@relayrunner/blacksmith-cli/protocol`): the port and the request and response types.
- `src/commands.ts`: the CLI arguments, how far back `jobs list` reaches, when paging stops, and how errors are classified and scrubbed.
- `src/server.ts`: the HTTP server the container runs. Node runs it as TypeScript directly (type stripping), so it uses no TypeScript-only syntax.
- `Dockerfile`: the image. `apps/api/wrangler.jsonc` points at it, and deploying the API builds and pushes it when anything in this folder changed (and then needs Docker).
