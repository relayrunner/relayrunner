# @relayrunner/log

The Workers' logger. Each line is one JSON object with `level`, `event`, `msg` and the Worker's `service`, `env` and `version`, plus the fields of the surrounding context and the line's own. [docs/observability.md](../../docs/observability.md#logs) has the field rules and the catalog of wide events.

```ts
import { createLogger, withLogContext } from "@relayrunner/log";

const log = createLogger<"routing.decision">({ service: "api" });

await withLogContext({ requestId, workspaceId }, async () => {
  log.info("routing.decision", "job routed", { result: "routed", step: "machine" });
});
```

- `createLogger(config)` takes the config, or a function that returns it on the first line (so it can read bindings that only exist once the Worker runs). `format: "pretty"` prints one readable line for a terminal.
- `withLogContext(fields, fn)` adds fields to every line inside `fn`, and `addLogContext(fields)` adds to the current context once more ids are known.
- `log.with(fields)` returns a logger that adds fields to its own lines.

The context uses `AsyncLocalStorage`, so a Worker that uses it needs the `nodejs_compat` flag.
