---
title: Introduction
description: What RelayRunner does and how jobs get routed.
sidebar:
  order: 1
---

:::note[Placeholder]
This page is a placeholder while the user documentation is written.
:::

RelayRunner routes each GitHub Actions job to the best runner available: your own machine when it's online, another provider you've connected, or GitHub's hosted runners as a fallback.

## How it works

1. Your workflow calls the `relay.yml` reusable workflow.
2. The router picks a runner from the order you set in the dashboard.
3. If none of your machines can take the job, it runs on GitHub.
