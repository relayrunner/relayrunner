---
"relayrunner": minor
---

`relayrunner init` no longer skips a job just because it can request OIDC tokens (`id-token: write`), such as for a Turbo or Vercel remote cache. It's still a deploy job when it uses the token to sign in to a cloud or publish a package; otherwise it's ready, with a warning. `--allow-deploy <jobs>` routes jobs that look like deploy jobs, once you're fine giving the machine their secrets.
