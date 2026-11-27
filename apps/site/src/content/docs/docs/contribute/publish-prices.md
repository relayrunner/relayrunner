---
title: Publish your prices
description: Keep your service's list prices current by hosting a price file on your own site.
---

If you run a runner service, you can publish your list prices in a small JSON file on your own site. A daily check reads it, so a price change reaches everyone's cost estimates within a day, with no pull request.

## The file

```json
{
  "$schema": "https://relayrunner.dev/schemas/runner-prices.json",
  "version": 1,
  "prices": [
    { "rate": "linux", "per": "vcpu", "usd_per_minute": "0.002" },
    { "rate": "linux", "per": "vcpu", "usd_per_minute": "0.0025", "from": "2027-01-01" },
    { "rate": "macos", "per": "vcpu", "usd_per_minute": "0.0133" }
  ]
}
```

| Field            | What it holds                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`        | Always `1`.                                                                                                                                                                                                                  |
| `rate`           | The rate's id. Your service's ids are listed under `RATES` in [`packages/providers/src/prices.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/prices.ts). Some are a platform, some a size. |
| `per`            | `vcpu` when one minute of the rate is priced per vCPU, or `runner` when it's the whole runner. It has to match `RATES`.                                                                                                      |
| `usd_per_minute` | The list price of one minute in US dollars, written as a string such as `"0.004"` so it isn't rounded.                                                                                                                       |
| `from`           | Optional. The UTC day the price starts, such as `"2027-01-01"`. Leave it out for a price that applies now.                                                                                                                   |

List the prices anyone pays without a plan or discount. You can announce a change ahead of time by listing the new price with its `from` day next to the current one.

The [JSON Schema](https://relayrunner.dev/schemas/runner-prices.json) describes the same format, so your editor or CI can check the file before you publish it. The format is strict. Any field not in the table, a price written as a number, or a `per` that doesn't match makes the check ignore the whole file until it's fixed, and your current prices stay as they are.

## Set it up

1. Host the file at `https://<your-domain>/.well-known/runner-prices.json`. Any `https` URL on a domain you control works.
2. Email the URL to [feedback@relayrunner.app](mailto:feedback@relayrunner.app). A maintainer adds it once, and from then on the file is the only place you need to change.

## When a change applies

A change applies on its own when it starts today or later and is less than double, and more than half, the current price. A bigger jump, or a price for a day that has already passed, waits for a maintainer to approve it, so a typo can't reprice everyone's jobs.

A rate that isn't in `RATES` yet is skipped. To add a new size, see [Add a provider](/docs/contribute/add-provider).
