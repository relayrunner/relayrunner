# Observability

All four Workers send logs and traces to Workers Observability in the Cloudflare dashboard (`observability` in each `wrangler.jsonc`). Each Worker can also export the same logs and traces over OpenTelemetry (OTLP) to an outside backend.

## What gets traced

Cloudflare traces every invocation on its own: fetch handlers, queue batches, cron runs, Durable Object calls and alarms, D1 queries, R2 and KV calls, and outbound `fetch`. On top of that, the code adds a few spans of its own (`apps/api/src/tracing.ts`):

| Span                  | Where                                        | Tagged with                                                                |
| --------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `webhook.process`     | API queue consumer, one per delivery         | `github.event`, `github.action`, `github.delivery_id`, repo, job, run, lag |
| `webhook.dead_letter` | API DLQ consumer, one per dead letter        | Same as above                                                              |
| `router.route`        | `Router.route`, one per routing decision     | Workspace, repo, run, the runner and step chosen, or the reason for none   |
| `pick.run`            | `PickRunner` alarm, one per pick runner      | Job, repo, attempt, result (`routed`, `no_runner`, `error`...), runner     |
| `machine.run`         | `MachineLink.run`, one per job sent to a Mac | Machine, route, job, result (`sent`, `offline`...)                         |

API requests are named after the route they matched, such as `GET /api/machines/:id`. The webhook ingress tags its request with `github.delivery_id`. Queue sends and consumes land in separate traces, so search for that id to follow one delivery from ingress to the consumer.

### Who made the call

Requests and spans carry ids, never emails, names or logins, so you can find everything one user, workspace or machine did:

| Attribute                    | Set on                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `user.id`                    | API requests from a dashboard session, an agent token or a machine token (the owner), MCP calls |
| `relayrunner.workspace_id`   | API requests for a workspace, `router.route`, `machine.run`                                     |
| `relayrunner.agent_grant_id` | API requests and MCP calls made with an agent token                                             |
| `relayrunner.machine_id`     | Machine-token API requests, the machine's WebSocket messages, `machine.run`                     |
| `github.installation_id`     | `webhook.process`, `router.route`, `pick.run`                                                   |

These land on the request's root span (or on the custom span that ran), and Workers Issues shows them with each occurrence. To filter, open **Workers & Pages** > **Observability**, pick **Traces** or the Query Builder, and add a filter such as `user.id = <id>`. A log line belongs to its invocation's trace, so open the trace from the log to see these ids.

To add a span, wrap the work in `traced(name, attributes, fn)`. Use `annotate(attributes)` to tag whichever span is active. In tests, `cloudflare:workers` resolves to `tests/cloudflare-workers.ts`, whose tracing does nothing.

## Export to an OTLP backend

1. In the Cloudflare dashboard, go to **Observability** > **Destinations** and add one destination for traces and one for logs, with the backend's OTLP endpoints and auth header. Cloudflare sends OTLP over HTTP with JSON, not protobuf.
2. List the destination names in each Worker's `wrangler.jsonc`:

   ```jsonc
   "observability": {
     "enabled": true,
     "logs": { "enabled": true, "invocation_logs": true, "destinations": ["grafana-logs"] },
     "traces": { "enabled": true, "destinations": ["grafana-traces"] },
     "issues": { "enabled": true },
   },
   ```

3. Deploy. Data takes a few minutes to show up.

The auth header lives in the destination, never in the repo. Exports go out alongside Workers Observability, which keeps working. Add `"persist": false` to stop storing a signal in Cloudflare once the backend has replaced it. Every request is traced today. If volume outgrows the backend's plan, set `traces.head_sampling_rate` (for example `0.1`).
