---
title: Routing retries through GitHub outages
date: 2026-11-25
type: Reliability
description: The Router keeps retrying through GitHub errors for about 20 minutes, and the site and dashboard show RelayRunner's live status.
---

- **Retries through GitHub errors.** When GitHub answers with a server error while the Router picks a runner, it now retries for about 20 minutes, backing off from 15 seconds to 2 minutes, and checks the job still needs a runner before each try. Before, a few quick failures could leave a job waiting for the next sweep.
- **Live status.** The site's footer and the dashboard's sidebar show whether everything is working, and the dashboard shows a banner on every page during an incident. Details are on [status.relayrunner.dev](https://status.relayrunner.dev).
