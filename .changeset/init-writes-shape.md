---
"relayrunner": minor
---

`relayrunner init` now writes what each job needs instead of its old provider's label: `os`, plus `arch` when the label isn't the usual one (such as `ubuntu-24.04-arm` or `macos-13`) and `cpus` when it asks for more than 2 (such as `blacksmith-8vcpu-ubuntu-2404`). Every runner on your Router page can then take the job. `--exact` keeps the old label as before. `--auto` is no longer needed and does nothing. Routed jobs use relay.yml `v1.0.0-beta.10`.
