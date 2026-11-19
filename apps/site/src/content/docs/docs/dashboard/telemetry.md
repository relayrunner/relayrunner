---
title: Telemetry
description: Send every workflow run to your observability tool as an OpenTelemetry trace, and job logs alongside.
---

Each workflow run can go to your observability tool as a trace: the run, its jobs and their steps, with where each job ran and how long it waited for a runner. Traces use the [OpenTelemetry](https://opentelemetry.io) format and its [CI/CD conventions](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/), so Honeycomb, Grafana, Axiom or your own OpenTelemetry Collector can read them without setup.

Every job in your connected repos is included, whichever runner took it. You can also send [job logs](#job-logs) to the same tool.

## Set up

1. Open **Settings → Telemetry**. Owners and admins can change it.
2. Pick where to send traces, or choose **Other** and paste any endpoint that accepts OTLP over HTTP with JSON. Traces go to the endpoint's `/v1/traces`.
3. Add the headers your tool wants, usually an API key. Values are stored encrypted and never shown again.
4. Save, then click **Send test trace**. A trace named `RUN RelayRunner test` shows up in your tool.

From then on, each job goes out when it finishes and each run when it completes.

## Spans

| Span name              | Description                                                                        | When sent              |
| ---------------------- | ---------------------------------------------------------------------------------- | ---------------------- |
| `RUN {workflow}`       | The run attempt, from when it started to when it completed. The root of the trace. | When the run completes |
| `{job name}`           | One job, from when GitHub queued it to when it finished.                           | When the job finishes  |
| `Waiting for a runner` | The time between GitHub queuing the job and a runner taking it.                    | With its job           |
| `{step name}`          | One step of the job. Skipped steps are left out.                                   | With its job           |

Failed runs, jobs and steps have an error status and an `error.type`.

Ids come from GitHub's run and job ids, so a job sent early and its run sent later land in the same trace.

## Attributes

The run span:

- `cicd.pipeline.name`, `cicd.pipeline.run.id`, `cicd.pipeline.run.url.full`, `cicd.pipeline.result`
- `vcs.ref.head.name`, `vcs.ref.head.revision`, `vcs.change.id` (the pull request number)
- `relayrunner.run.attempt`, `relayrunner.run.event` (push, pull_request and so on), `relayrunner.run.title`, `relayrunner.run.actor`
- `relayrunner.routed`: whether the run went through the [Router](/docs/concepts/routing)
- `relayrunner.route.provider` and `relayrunner.route.skipped`: where the Router sent it, and what it passed over and why
- `relayrunner.retry`: whether this attempt was an [automatic retry](/docs/concepts/routing#automatic-retries)

Each job span:

- `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, `cicd.pipeline.task.run.url.full`, `cicd.pipeline.task.run.result`, `cicd.worker.name`
- `relayrunner.provider`: where it ran, such as `machine`, `github` or `depot`
- `relayrunner.runner`: the machine's name or the runner type
- `relayrunner.labels`: the job's `runs-on` labels
- `relayrunner.queue.wait_ms` and `relayrunner.billed_minutes`
- `relayrunner.cpu.p95`, `relayrunner.memory.p95_mb`, `relayrunner.cpus`, `relayrunner.memory_mb`: on machines that report usage

The resource carries `service.name` (`github-actions` unless you change it), `vcs.repository.name`, `vcs.repository.url.full` and `vcs.owner.name`.

## Job logs

Under **Job logs**, choose **Failed jobs** or **Every job** to send logs too. They go to the same endpoint's `/v1/logs`, with the same headers. Each job's log goes out when the job finishes.

- Each line is a log record with GitHub's timestamp. Lines that start with `##[error]` or `##[warning]` get that severity.
- Each record carries the trace and span ids of its step, so a tool that shows traces can show a step's lines with it. `relayrunner.step.number` and `relayrunner.step.name` name the step.
- The resource carries the repository and the job: `cicd.pipeline.name`, `cicd.pipeline.task.name`, `cicd.pipeline.task.run.id`, `cicd.pipeline.task.run.url.full`, `relayrunner.run.attempt` and `relayrunner.job.conclusion`.
- A log over 20 MB keeps its first 16 MB and last 4 MB, with a line between that says how much was left out and links to the full log on GitHub.

Logs come from GitHub, which replaces your repository's secrets with `***` before it stores them. As a backstop, anything that looks like a credential, such as a GitHub or AWS key, a bearer token or a private key, is replaced with `[redacted]`. A value that was never stored as a secret can still show up, so treat logs in your tool with the same care as on GitHub.

Each log costs one call from your GitHub App installation's hourly API limit, which routing also uses. When fewer than a quarter of those calls are left, logs wait until the limit resets. Failed jobs are the default for this reason.

## When sending fails

If your endpoint is down or rate limiting, sending retries for about an hour. If it refuses the key, the error shows in **Settings → Telemetry**. After three days of nothing but errors, sending traces and logs pauses until you save the settings again. When a job's log can't be sent, for example because GitHub no longer has it, the reason shows there too.

## What gets sent

Traces hold repository and workflow names, branches, commit SHAs, pull request titles, GitHub usernames, job and step names, timings and where each job ran. They never hold logs, secrets or environment variables.

With job logs on, the log lines go out as well. Nothing keeps a copy on the way: each log streams from GitHub to your endpoint.
