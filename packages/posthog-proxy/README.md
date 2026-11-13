# @relayrunner/posthog-proxy

Forwards `/ingest/*` on our own domains to PostHog (US cloud), so analytics requests are
first-party and ad blockers don't drop them. The site Worker (`apps/site`) and the dashboard Worker
(`apps/web`) both call `proxyPostHog` for `/ingest/*`, and their posthog-js clients use
`api_host: "/ingest"`. Nothing here names our domain, so a domain move needs no change.
