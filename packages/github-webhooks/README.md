# @relayrunner/github-webhooks

What the webhooks Worker and the API's queue consumer share about GitHub deliveries.

Used by [`apps/webhooks`](../../apps/webhooks), which verifies and enqueues, and [`apps/api`](../../apps/api), which consumes.

## What's in it

- **`verifyGitHubSignature`** checks a delivery's `X-Hub-Signature-256` (an HMAC-SHA256 of the raw body) against the webhook secret, with WebCrypto.
- **`toWebhookMessage`** turns a verified delivery into a compact `WebhookMessage`, or returns null for an event RelayRunner doesn't act on. It handles `workflow_job`, `workflow_run`, `installation`, `installation_repositories`, `repository`, `pull_request` and `check_suite`.
- **`WEBHOOK_QUEUE`** and **`WEBHOOK_DLQ`** name the Cloudflare Queues the message travels on.

A message carries only the fields the consumer uses, never the raw payload, because a queue message is capped at 128 KB and GitHub payloads can be much larger. Add a field to `src/message.ts` when the consumer needs one. Messages from the RelayRunner Checks App carry `app: "checks"` so the consumer keeps them apart from the main App's work.
