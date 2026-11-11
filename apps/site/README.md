# Landing page

The public site at [relayrunner.app](https://relayrunner.app): one [Astro](https://astro.build) build served as Worker static assets (Worker `relayrunner-site`, no Worker script). The home page, privacy policy and terms are `src/pages/index.astro`, `privacy.astro` and `terms.astro`, plain HTML with `src/style.css`, `src/legal.css` and `src/main.ts`. The docs are [Starlight](https://starlight.astro.build) pages at `/docs/`, written in `src/content/docs/docs/`. Pages can be `.md` or `.mdx`; MDX pages can import components, such as `<Provider id="depot" />` and `<ProviderTable />` from `@/components/docs/`, which read names, labels and list prices from `@relayrunner/providers`. When you add a component, also teach `componentsToMarkdown` in `src/lib/agent-docs.ts` to write it out for the pages' `.md` and `.txt` versions. [DESIGN.md](DESIGN.md) holds the visual system, which the dashboard's theme borrows from.

```sh
pnpm --filter @relayrunner/site dev          # local dev server
pnpm --filter @relayrunner/site build:site   # production build into dist/
pnpm run deploy:site                         # build and deploy (from the repo root)
pnpm run deploy:site:preview                 # build and upload a preview of the current branch
```

`site` in `astro.config.mjs` is the absolute origin used by the canonical link and the Open Graph and Twitter share image tags; set `SITE_URL` to override it. Docs search (Pagefind) only works in `build` output.

## Deploys

Workers Builds deploys it on merge to `main`, like the other Workers, with root directory `/` and deploy command `pnpm run deploy:site`. Branch and PR builds run `pnpm run deploy:site:preview`, which uploads a preview version.

## Moving to relayrunner.dev

Once the relayrunner.dev zone is in the RelayRunner Cloudflare account, add `relayrunner.dev` to `routes` in `wrangler.jsonc`, change `SITE_URL` in `build:site` to `https://relayrunner.dev`, and decide whether relayrunner.app keeps serving the page or redirects.
