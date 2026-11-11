# @relayrunner/activity

The workspace's activity log: the event types the API records and the dashboard's Activity page shows. Each row is append-only, and its `data` is checked against the event's schema here when the API writes it. The dashboard renders each type from the same definitions.

Used by [`apps/api`](../../apps/api) and [`apps/web`](../../apps/web).

## What's in it

- **`ActivityEvent`**: a Zod discriminated union of every event type, such as `machine.enrolled`, `machine.paused`, `member.invited`, `job.routed`, `job.unroutable` and `check.completed`.
- **`RouteWalk`**: how a pick walked the runner order: the provider that took the job, the earlier steps it skipped and why (`SKIP_REASONS`), and the providers the relay named that the order leaves out.
- **Feed types** (`ActivityItem`, `ActivityPage`, `ActivityQuery`, ...): the shape of `GET /api/activity`. They are types only; the API builds the response and the dashboard reads it.
- **Filters**: `ACTIVITY_FILTERS` and `ACTIVITY_RESULTS`, the options the Activity page filters by.

## Adding an event type

Add an entry to `ActivityEvent` in `src/events.ts` and teach the Activity page how to show it. Events are stored as JSON, so a new type never needs a migration. Keep enough in `data` for the log to read on its own later, such as the machine's name at the time rather than only its id.
