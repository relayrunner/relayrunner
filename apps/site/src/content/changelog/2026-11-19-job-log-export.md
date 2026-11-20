---
title: Send job logs to your tools or your own bucket
date: 2026-11-19
description: Send finished jobs' logs to your OpenTelemetry tool next to their traces, or archive them in an S3-compatible bucket.
---

- **Job logs with your traces.** Under **Settings → Telemetry**, choose **Failed jobs** or **Every job** for **Job logs**, and each finished job's log goes to the endpoint that gets your traces. Each line carries its step's span, so a tool that shows traces shows a failed step's output under it. See [Job logs](/docs/dashboard/telemetry#job-logs).
- **Log archive.** Keep job logs in a bucket you own on Amazon S3, Cloudflare R2, Google Cloud Storage or any other service that speaks the S3 API, as one gzipped NDJSON file per job. It works with or without a telemetry endpoint. See [Log archive](/docs/dashboard/telemetry#log-archive).
- **Nothing kept on the way.** Each log streams from GitHub to where you send it. Anything that looks like a credential is replaced with `[redacted]`, and a log over 20 MB keeps its first 16 MB and last 4 MB.
- **Changes in Activity.** Turning job logs or the archive on or off, pointing telemetry at another endpoint or the archive at another bucket, and changing headers or access keys all show in **Activity**.
