---
title: For runner providers
description: Get your runner service listed, routed to, and priced correctly.
---

If you run a GitHub Actions runner service, people can route jobs to it and see what those jobs cost. This page covers how to get your service listed and how to keep its details current.

## Get listed

A listed service shows up in two ways:

- **Recognized**: jobs that run on your labels show up under your name on the dashboard's Providers page, with cost estimates at your list prices. This works for jobs people didn't route too.
- **Routed**: your service is a step people can add to their [runner order](/docs/concepts/runner-order), and a relay input of the same name picks one of your labels.

There are two ways to get there:

1. **Open a pull request.** [Add a provider](/docs/contribute/add-provider) lists every file to change. It covers recognition and routing in one go.
2. **Email [feedback@relayrunner.app](mailto:feedback@relayrunner.app).** A maintainer can recognize your labels the same day, with no deploy. Routing to your service still needs the pull request, which a maintainer can open for you.

A new service starts hidden: its jobs are recognized, but the Providers page doesn't offer it yet. A maintainer makes it live once jobs have run on it.

## What to send

- Your service's name, a one-line summary, and links to your docs and dashboard.
- How your `runs-on` labels look, with an example, such as `acme-4vcpu-ubuntu-2404`.
- Your logo as an SVG.
- Whether you run public repos' jobs and personal accounts' jobs, so routing skips you where you'd refuse a job.
- Your runner sizes and list prices.

## Keep your prices current

Publish your prices in a [price file](/docs/contribute/publish-prices) on your own site. A daily check reads it, so a price change reaches everyone's cost estimates within a day, with no pull request.

## Show real cost

If your service has an API that reports usage per job with a read-only token, tell us. People can then connect their account and see what their jobs actually cost, alongside the estimates.
