---
title: Runner labels
description: Every runs-on label RelayRunner uses or answers, and what it means.
---

## Labels you write

| Label                              | Where                                                                    | Meaning                                                               |
| ---------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `relayrunner`                      | A relay job's `runs-on` (set by the relay workflow), or a free-check job | RelayRunner answers this job itself, with no runner.                  |
| `self-hosted`                      | The relay's `machine` input                                              | Any connected machine or added runner.                                |
| `macOS`, `Linux`                   | The relay's `machine` input                                              | A machine with that OS.                                               |
| `ARM64`, `X64`                     | The relay's `machine` input                                              | A machine with that architecture.                                     |
| `ubuntu-latest`, `macos-latest`, … | The relay's `github` input                                               | A GitHub-hosted runner.                                               |
| `blacksmith-*`, `depot-*`, …       | A hosted provider's input, such as `depot`                               | That provider's runner. See [Hosted providers](/docs/runners/hosted). |

## Labels RelayRunner answers

After the relay answers, the job's `runs-on` is either a one-time `rr-…` label for one of your machines, or the provider label from the relay, such as `ubuntu-latest`. You never write these yourself.

## Labels RelayRunner recognizes

To show where jobs ran on the Providers, Usage and Job times pages, RelayRunner recognizes the labels of many runner services, routed or not. See [Providers](/docs/runners/providers#what-relayrunner-recognizes).
