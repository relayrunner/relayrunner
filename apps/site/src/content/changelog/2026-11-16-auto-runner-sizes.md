---
title: Pick runner sizes on the dashboard
date: 2026-11-16
description: Set a relay's provider to auto, and change each job's runner size on the Router page without a commit.
---

- **`auto` relay inputs.** Write `auto` in place of a label, such as `blacksmith: auto`, or leave the relay's inputs out. The Router then picks that provider's label for the job's size. A label you write still runs as written. See [Auto sizes](/docs/reference/relay-inputs#auto-sizes).
- **Job sizes on the Router page.** Click a workflow's auto jobs under **Workflows** to pick each job's size in vCPUs and a provider to try first. A provider without that size gets the next size up, or is skipped.
- **A default size.** Set the size auto jobs get when nobody picked one in **Router → Settings**.
