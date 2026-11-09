# Landing page

The public site at [relayrunner.app](https://relayrunner.app): a Vite build served as Worker static assets (Worker `relayrunner-landing`, no Worker script). It has the home page (`index.html`) and the privacy policy and terms (`privacy.html`, `terms.html`). [DESIGN.md](DESIGN.md) holds the visual system, which the dashboard's theme borrows from.

```sh
pnpm --filter @relayrunner/landing dev       # local dev server
pnpm --filter @relayrunner/landing build:site # production build into dist/
pnpm run deploy:landing                       # build and deploy (from the repo root)
```

`build:site` sets `VITE_SITE_URL`, the absolute origin used by the canonical link and the Open Graph and Twitter share image tags. For local builds, copy `.env.example` to `.env`.

## Deploys

Workers Builds deploys it on merge to `main`, like the other Workers, with root directory `/` and deploy command `pnpm run deploy:landing`. PR builds upload a preview version.

## Moving to relayrunner.dev

Once the relayrunner.dev zone is in the RelayRunner Cloudflare account, add `relayrunner.dev` to `routes` in `wrangler.jsonc`, change `VITE_SITE_URL` in `build:site` to `https://relayrunner.dev`, and decide whether relayrunner.app keeps serving the page or redirects.
