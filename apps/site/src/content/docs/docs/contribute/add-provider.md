---
title: Add a provider
description: Teach RelayRunner to recognize another runner service, with a pull request.
---

The dashboard recognizes runner services by their `runs-on` labels, so it can show where every job ran and what it cost. The list lives in code and changes by pull request. If a service you use shows up as **Other**, you can add it.

## What to change

1. **The provider's facts** in [`packages/providers/src/index.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/index.ts): add an id to `PROVIDER_IDS` and an entry to `PROVIDERS` with its name, a one-line summary, how its labels look, an example `runs-on`, and links to its docs and dashboard. The dashboard and these docs both read from here.
2. **Its list prices**, if it publishes them, in [`packages/providers/src/prices.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/prices.ts), with a comment naming the price page. Prices are estimates for the Providers page, so leave out plan allowances and discounts.
3. **How to match its labels** in `LABEL_MATCHERS` in the same file, with its id in `HOSTED_PROVIDER_IDS`. Most services use a prefix, such as `depot-`. Add a case to [`packages/providers/src/index.test.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/index.test.ts).
4. **Its logo**: an SVG in `apps/site/public/providers/`, and the icon and brand color the dashboard uses in `apps/web/src/components/providers.tsx` and `apps/web/src/styles.css`.

Run `pnpm check` from the repo root before you open the pull request. The repo's [README](https://github.com/relayrunner/relayrunner#development) covers setup.

## Recognized and routed

A provider in `HOSTED_PROVIDER_IDS` is also a step in the runner order. To route to it, add an input of the same name to the relay workflow in [relayrunner/actions](https://github.com/relayrunner/actions) too.
