---
title: Data and privacy
description: What RelayRunner sees and stores about your jobs, repos and machines.
---

RelayRunner needs to know about your jobs to route them, but not what's in them. Here's what it sees. The [Privacy Policy](/privacy) has the full detail.

## What we store

- **Your account**: your GitHub user id, username, name, email and avatar.
- **Workspaces**: their members, roles and invitations.
- **Repositories**: names, ids and whether each is public or private, for the GitHub accounts you connect.
- **Runs and jobs**: repo, workflow and job names, who triggered them, status, timings, and where each job was routed and why.
- **Machines**: name, OS and hardware, and when each was last online.
- **Actions usage**: minutes and amounts per repo from GitHub billing, where the App has permission.

## What it never gets

- **Your code.** The App can only read `relayrunner.yml`. The one exception is lint: it reads a commit with the lint job's own token, or through the separate Checks App if you install it, lints it in a sandbox with no internet access and discards it.
- **Job logs and secrets.** Jobs on your machines use GitHub's runner, which talks to GitHub directly.
- **Provider accounts.** A routed job only gets a label. The provider, such as GitHub or Depot, runs it under your agreement with them.

## Who sees it

Members of a workspace see its machines, runners, activity and usage. The maintainers who run the service can see accounts and workspaces when they need to, to support you or keep it running. Nothing is sold, and there's no third-party analytics.

## Where it lives

The service runs on Cloudflare. Data is kept while you use the service.

## Delete your data

Email [privacy@relayrunner.app](mailto:privacy@relayrunner.app) to get a copy of your data or have it deleted. See [Remove RelayRunner](/docs/dashboard/remove) for switching off each part.
