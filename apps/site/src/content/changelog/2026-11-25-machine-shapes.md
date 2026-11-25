---
title: Say what a job needs, not where it runs
date: 2026-11-25
type: Feature
description: Relays take os, arch and cpus, so every runner on your Router can take a job, and relayrunner init writes them for you.
---

- **Shape inputs on the relay.** Give a relay `os`, `arch` or `cpus` and every provider in your runner order can take the job at its smallest runner that fits, and a machine fits when it has the OS and enough cores. Left out, `os` is Linux, `arch` is the OS's usual one, and the size comes from the Router page. Needs relay.yml `v1.0.0-beta.10`. See [relay.yml inputs](/docs/reference/relay-inputs#what-the-job-needs).
- **`relayrunner init` writes the shape.** It reads each job's `runs-on` label: `ubuntu-latest` becomes `os: linux`, `ubuntu-24.04-arm` adds `arch: arm64`, and `blacksmith-8vcpu-ubuntu-2404` adds `cpus: 8`. Add `--exact` to keep a job on its old label instead. See [Move your workflows over](/docs/get-started/move-over#what-it-writes).
- **Labels still work.** Relays that name a provider's label, or say `auto`, route as before.
