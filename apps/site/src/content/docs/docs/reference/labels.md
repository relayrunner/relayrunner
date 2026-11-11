---
title: Runner labels
description: Every runs-on label RelayRunner uses or answers, and what it means.
---

## Labels you write

| Label                              | Where                                                                    | Meaning                                              |
| ---------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `relayrunner`                      | A relay job's `runs-on` (set by the relay workflow), or a free-check job | RelayRunner answers this job itself, with no runner. |
| `self-hosted`                      | The relay's `machine` input                                              | Any connected machine or added runner.               |
| `macOS`, `Linux`                   | The relay's `machine` input                                              | A machine with that OS.                              |
| `ARM64`, `X64`                     | The relay's `machine` input                                              | A machine with that architecture.                    |
| `ubuntu-latest`, `macos-latest`, … | The relay's `github` input                                               | A GitHub-hosted runner.                              |
| `blacksmith-*`                     | The relay's `blacksmith` input                                           | A Blacksmith runner.                                 |

Labels ignore case, as on GitHub.

## Labels RelayRunner answers

These appear in a job's `runs-on` after the relay answers. You don't write them.

| Label                              | Meaning                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `rr-<12 hex>`                      | A one-time label for a connected machine. Only the job it was answered for can use it.                                                        |
| `rr-runner-<8 hex>`                | An [existing runner](/docs/runners/self-hosted/#runners-your-org-already-has) you added. RelayRunner puts this label on the runner on GitHub. |
| The `github` or `blacksmith` input | The provider's own label, passed through.                                                                                                     |

## Labels RelayRunner recognizes

To show where jobs ran on the Providers, Usage and Job times pages, RelayRunner recognizes the labels of many runner services, routed or not. See [Providers](/docs/runners/providers/#what-relayrunner-recognizes).
