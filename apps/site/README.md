# Landing page

The public site at [relayrunner.app](https://relayrunner.app): one [Astro](https://astro.build) build served as Worker static assets (Worker `relayrunner-site`). The home page, privacy policy and terms are `src/pages/index.astro`, `privacy.astro` and `terms.astro`, plain HTML with `src/style.css`, `src/legal.css` and `src/main.ts`. The docs are [Starlight](https://starlight.astro.build) pages at `/docs/`, written in `src/content/docs/docs/`. Pages can be `.md` or `.mdx`; MDX pages can import components, such as `<Provider id="depot" />` and `<ProviderTable />` from `@/components/docs/`, which read names, labels and list prices from `@relayrunner/providers`. When you add a component, also teach `componentsToMarkdown` in `src/lib/agent-docs.ts` to write it out for the pages' `.md` and `.txt` versions. [DESIGN.md](DESIGN.md) holds the visual system, which the dashboard's theme borrows from.

## Share images

`src/lib/share-images.mjs` draws the site's share images and the README hero with [Satori](https://github.com/vercel/satori) and resvg. Each docs page gets its own share image at `/og/docs/<slug>.png`, drawn at build time from its section, title and description (`src/pages/og/[...route].ts`). Each integration page gets one at `/og/integrations/<id>.png` that shows its provider taking the job after busy machines (`src/pages/og/integrations/[id].png.ts`). The home page's `public/og-image.png` and the README hero in `.github/readme/` are files: after changing a layout, run `pnpm images` to write them again.

## For agents

Every docs page has a Markdown version at `/docs/<slug>.md` and a plain-text one at `/docs/<slug>.txt`, linked from the page's `<head>` as `rel="alternate" type="text/markdown"`; the home page's is `/index.md` (`src/pages/index.md.ts`, kept in step with `index.astro` by hand). `/llms.txt` (also at `/docs/llms.txt`) says when an agent should reach for RelayRunner and how, and lists every page; `/llms-full.txt` has all of them in one file. For search engines, `/sitemap-index.xml` (also at `/sitemap.xml`, and named in `/robots.txt`) lists every page with the date of its last commit, generated at build time, so new pages show up on their own. The home page also carries schema.org JSON-LD.

`/setup.md` is the setup guide for coding agents ("Set up relayrunner in this checkout using https://relayrunner.app/setup.md"), and `/skills/<name>/SKILL.md` are the agent skills it links to. Both are built from the repo's `docs/agent-install.md` and `skills/` (`src/lib/agent-setup.ts`), with raw GitHub links to the skills rewritten to the site's own URLs, so edit those files, not the site.

The small Worker script in `worker/index.ts` runs first for `/` and `/docs/*`, and for any path with no file (`not_found_handling: "none"`). Asking for one of those pages with `Accept: text/markdown` returns its Markdown, with `Vary: Accept`. An unknown path gets a 404: the 404 page, or a short Markdown note with links for agents. It also swaps the home page's share image for campaigns (above).

Machine-readable files for agents:

- `/openapi.json`: the agent API (`src/lib/openapi.ts`), documented at `/docs/reference/api` and rendered by Scalar at `/docs/reference/api/routes` (`src/pages/docs/reference/api/routes.astro`). `apps/api/src/agent-openapi.test.ts` fails when it drifts from the routes agent tokens may call.
- `/.well-known/ai-catalog.json`: points agents at the MCP server's card, which the server serves itself at `https://agents.relayrunner.app/mcp/server-card`. `/.well-known/mcp.json` and `/.well-known/mcp/server-card.json`, where older clients look, redirect there.

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

`relayrunner.dev` is attached as a second custom domain in `wrangler.jsonc`, so both domains serve the site. To switch over, change `SITE_URL` in `build:site` to `https://relayrunner.dev`, then redirect relayrunner.app to it.
