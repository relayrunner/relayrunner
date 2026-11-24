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

## Logs

The API logs through `@relayrunner/log` (`apps/api/src/log.ts`), never `console.*` directly (oxlint's `no-console` rule enforces it outside tests and scripts). Each line is one JSON object:

```json
{
  "level": "info",
  "event": "routing.decision",
  "msg": "job routed",
  "service": "api",
  "env": "production",
  "version": "4f1c…",
  "requestId": "8f3c…-IAD",
  "workspaceId": "ws_…",
  "repo": "acme/app",
  "runId": 654,
  "result": "routed",
  "step": "github",
  "runnerKind": "github",
  "decideMs": 38
}
```

- `event` is the stable name dashboards and alerts filter on. It never changes once it ships. `msg` is for people and can change at any time. Every event is listed in `API_EVENTS` (`apps/api/src/log.ts`), so a typo fails the typecheck.
- `level` is `debug`, `info`, `warn` or `error`, and each goes to its own `console` method, so the Workers Observability level filter works. `LOG_LEVEL` drops lines below it (default `info`).
- Ids use one set of names: `workspaceId`, `installationId`, `userId`, `machineId`, `repo` (owner/name), `jobId`, `runId`, `routeId`, `deliveryId`, `provider`. Log user ids, never emails, names or logins.
- Durations are milliseconds and end in `Ms` (`waitMs`, `lagMs`). Fields a chart groups by take a short, fixed set of snake_case values.
- An `error` field takes anything thrown and is logged as `{ name, message, stack, cause }`.

Each entry point sets the ids its lines share with `withLogContext`: a request (its Ray ID as `requestId`), a webhook delivery (its delivery id), a routing decision. `annotate` adds the ids it puts on the span (user, workspace, machine) to the log context too. Run `pnpm dev` with `LOG_FORMAT=pretty` (in `.dev.vars.example`) to read lines in the terminal.

### Wide events

A wide event is one line per unit of work, written when its outcome is known, with every field a chart groups or filters by. Dashboards count these. Other lines are warnings, errors and detail for debugging.

| Event               | Written when                                                                                        | Group by                                                                                                  | Measures                          |
| ------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `routing.decision`  | The Router decides where a run's job goes (`Router.route`, and `Router.reroute` with `rerun: true`) | `result` (`routed`, `waiting`, `no_runner`), `step`, `runnerKind`, `reason`                               | `decideMs`                        |
| `pick.finished`     | A pick runner ends (`PickRunner` alarm)                                                             | `result` (`routed`, `no_runner`, `not_needed`, `error`...), `runner`, `next` (`rearm`, `done`, `give_up`) | `durationMs`                      |
| `webhook.processed` | The queue consumer finishes or retries a GitHub delivery                                            | `app`, `githubEvent`, `action`, `status` (`processed`, `retrying`), `handler`, `result`                   | `lagMs`, `durationMs`, `attempts` |
| `machine.dispatch`  | A job is handed to a machine, from its webhook or the waiting line                                  | `source`, `result` (`sent`, `offline`, `wrong_place`, `error`)                                            | `sendMs`, `waitMs`                |

Never sample wide events, so their counts stay exact. In Grafana, count them with LogQL, for example routing decisions by hour:

```logql
sum by (result) (count_over_time({service_name="relayrunner-api"} | json | event="routing.decision" [1h]))
```

Only `service_name` (and the level) are stream labels. Ids stay in the line, so filter on them after `| json` rather than grouping by them.

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
