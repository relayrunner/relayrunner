# RelayRunner webhooks

GitHub webhook ingress, on its own Cloudflare Worker. It verifies each delivery's signature, turns it into a compact `WebhookMessage` (from `packages/github-webhooks`) and puts it on the `relayrunner-github-webhooks` queue. The API Worker (`apps/api`) consumes the queue and does the work.

```
GitHub ──▶ relayrunner-webhooks ──▶ queue ──▶ relayrunner-api queue()
           verify + enqueue                    │ 6 retries, backoff
                                               ▼
                                              DLQ ──▶ archive to R2 + ack
```

Two GitHub Apps post here, each to its own path and signed with its own Secrets Store secret:

| Path                          | App                                     | Secret                        |
| ----------------------------- | --------------------------------------- | ----------------------------- |
| `/api/webhooks/github`        | RelayRunner (routing, PR title check)   | `GITHUB_WEBHOOK_SECRET`       |
| `/api/webhooks/github-checks` | RelayRunner Checks (opt-in lint checks) | `GITHUB_CHECK_WEBHOOK_SECRET` |

Messages from the Checks App carry `app: "checks"`, so the consumer never runs the main App's work on them; it starts lint check runs for them instead.

It is separate from the API so that API deploys, and bugs in processing, never change what GitHub sees. While the API is broken, messages wait and retry (30 seconds, doubling, up to about half an hour in total) instead of failing deliveries. Keep this Worker small: it should rarely need a deploy.

| Response | When                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `200`    | `ping`                                                                                                  |
| `202`    | Queued, or an event RelayRunner doesn't act on                                                          |
| `401`    | Missing or wrong signature                                                                              |
| `500`    | The path's webhook secret can't be read from the Secrets Store                                          |
| `503`    | The queue rejected the message. GitHub doesn't retry, so redeliver it from the App's Recent Deliveries. |

Queue messages carry only the fields the consumer uses, never the raw payload, because a message is capped at 128 KB. Delivery is at least once and unordered, so processing must be idempotent.

## Run it locally

Run it in the same `wrangler dev` as the API so the local queue connects producer and consumer:

```sh
# once: seed the local Secrets Store (prompts for the value)
npx wrangler secrets-store secret create eac3493b9fef4234a832f5f3fdcc8a41 --name GITHUB_WEBHOOK_SECRET --scopes workers -c apps/webhooks/wrangler.jsonc
npx wrangler secrets-store secret create eac3493b9fef4234a832f5f3fdcc8a41 --name GITHUB_CHECK_WEBHOOK_SECRET --scopes workers -c apps/webhooks/wrangler.jsonc
npx wrangler dev -c apps/webhooks/wrangler.jsonc -c apps/api/wrangler.jsonc
```

## Deploy

Once per account, create the queues:

```sh
wrangler queues create relayrunner-github-webhooks
wrangler queues create relayrunner-github-webhooks-dlq
```

`GITHUB_WEBHOOK_SECRET` and `GITHUB_CHECK_WEBHOOK_SECRET` already live in the account's Secrets Store, so there's nothing to set. Then deploy in this order, since each step binds to the one before it:

```sh
pnpm run deploy:webhooks
pnpm run deploy:api    # attaches the queue consumers
pnpm run deploy:web    # forwards /api/webhooks/* here
```

The GitHub App's webhook URL is `https://webhooks.relayrunner.app/api/webhooks/github`, this Worker's custom domain, so deliveries reach it directly. `https://relayrunner-webhooks.relayrun.workers.dev` is the same Worker. The dashboard also forwards `/api/webhooks/*` here, so `<dashboard origin>/api/webhooks/github` works too. The Checks App posts to `https://webhooks.relayrunner.app/api/webhooks/github-checks`.
