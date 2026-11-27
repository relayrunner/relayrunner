---
title: Get listed
description: Get a runner service recognized, routed to, and priced correctly.
---

Already listed? [Publish your prices](/docs/providers/publish-prices) so price changes reach everyone without a pull request.

If you run a GitHub Actions runner service, or use one that shows up as **Other**, it can be listed in two ways:

- **Recognized**: jobs that run on its labels show up under its name on the dashboard's Providers page, with cost estimates at its list prices. This works for jobs people didn't route too.
- **Routed**: the service is a step people can add to their [runner order](/docs/concepts/runner-order), and a relay input of the same name picks one of its labels.

A new service starts hidden: its jobs are recognized, but the Providers page doesn't offer it yet. A maintainer makes it live once jobs have run on it.

## Email us

Send these to [feedback@relayrunner.app](mailto:feedback@relayrunner.app). A maintainer can recognize the labels the same day, with no deploy, and opens the pull request for routing.

- The service's name, a one-line summary, and links to its docs and dashboard.
- How its `runs-on` labels look, with an example, such as `acme-4vcpu-ubuntu-2404`.
- Its logo as an SVG.
- Whether it runs public repos' jobs and personal accounts' jobs, so routing skips it where it would refuse a job.
- Its runner sizes and list prices.
- If it has an API that reports usage per job with a read-only token, say so. People can then connect their account and see what their jobs actually cost, alongside the estimates.

## Or open a pull request

A pull request covers recognition and routing in one go. Change these:

1. **The provider's facts** in [`packages/providers/src/index.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/index.ts): add an id to `PROVIDER_IDS` and an entry to `PROVIDERS` with its name, a one-line summary, how its labels look, an example `runs-on`, and links to its docs and dashboard. Add `hidden: true` so it starts hidden. The dashboard and these docs both read from here.
2. **Its list prices**, if it publishes them, in [`packages/providers/src/prices.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/prices.ts), with a comment naming the price page. Leave out plan allowances and discounts. After that, the service keeps its prices current with a [price file](/docs/providers/publish-prices).
3. **How to match its labels** under `labelPrefixes` in `packages/providers/src/relay.json`, with its id in `HOSTED_PROVIDER_IDS` in `index.ts`, and the slug of its GitHub App in `APP_SLUG_PATTERNS`. Most services use a prefix, such as `depot-`. If it refuses public repos or personal accounts, add it to `SKIPS_PUBLIC_REPOS` or `SKIPS_PERSONAL_ACCOUNTS`, and give it `auto` sizes in `auto-sizes.ts` that every account can run. Add a case to [`packages/providers/src/index.test.ts`](https://github.com/relayrunner/relayrunner/blob/main/packages/providers/src/index.test.ts).
4. **Its logo**: an SVG in `apps/site/public/providers/`, and the icon and brand color the dashboard uses in `apps/web/src/components/providers.tsx` and `apps/web/src/styles.css`.
5. **Routing**: add an input of the same name to the relay workflow in [relayrunner/actions](https://github.com/relayrunner/actions). The CLI reads the prefixes from the same `relay.json`.

Run `pnpm check` from the repo root before you open the pull request. The repo's [README](https://github.com/relayrunner/relayrunner#development) covers setup.
