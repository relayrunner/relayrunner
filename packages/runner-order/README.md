# @relayrunner/runner-order

A workspace's runner order: the ordered list of providers RelayRunner may route its jobs to. The API's `Router` walks it top to bottom and sends a job to the first provider that the job's relay names and that can take it now. A provider missing from the order is never used, and a job nothing fits fails fast with the reason.

Used by [`apps/api`](../../apps/api), [`apps/web`](../../apps/web) (the Runners page) and [`packages/activity`](../activity).

## What's in it

- **`RUNNER_KEYS`**: the providers a step can name: `machine` (self-hosted, both connected machines and existing runners), `github` and `blacksmith`. They match the relay workflow's inputs.
- **`runnerOrderSchema`**: the Zod schema for an order. It needs at least one step and no provider twice.
- **`DEFAULT_RUNNER_ORDER`**: what a workspace that never saved an order gets: a free machine, then GitHub-hosted.
- **`readRunnerOrder`**: reads the stored column. A missing or unreadable value reads as the default, so routing never stalls on a bad row.
- **`RUNNER_LABELS`**: how the dashboard names each provider.

Steps carry only a key today, since labels come from each job's relay. Rules per step, such as "while included minutes remain", will be added to the step objects.
