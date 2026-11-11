# Docs site

User documentation, built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build) and served as Worker static assets (Worker `relayrunner-docs`, no Worker script). This is a temporary app: the plan is to move it into the landing site so the docs live at relayrunner.app/docs.

```sh
pnpm --filter @relayrunner/docs dev     # local dev server at http://localhost:4321/docs/
pnpm --filter @relayrunner/docs build   # static build into dist/
pnpm run deploy:docs                    # build and deploy (from the repo root)
pnpm run deploy:docs:preview            # build and upload a preview of the current branch
```

## Writing a page

Every page is a Markdown (`.md`) or MDX (`.mdx`) file in `src/content/docs/`. The file path is the URL: `src/content/docs/guides/router.md` is `/docs/guides/router/`. Each folder is a sidebar group (see `sidebar` in `astro.config.mjs`), so adding a page means adding a file. Frontmatter needs a `title`; `description` feeds search results and link previews, and `sidebar.order` sorts pages within a group.

Starlight's [Markdown features](https://starlight.astro.build/guides/authoring-content/) work out of the box: asides (`:::note`, `:::tip`, `:::caution`), code blocks with titles and line highlights, and tables. MDX pages can also use its [components](https://starlight.astro.build/components/using-components/) (tabs, cards, steps, file trees).

Search (Pagefind) is built at build time, so it only works in `build` output, not in `dev`.

## Paths

`base` is `/docs` and the build goes to `dist/docs/`, so the files already sit where they will once the docs join the landing site. `scripts/postbuild.mjs` writes `dist/_redirects` to send `/` to `/docs/`. Links between pages need the `/docs/` prefix.

## Theme

`src/styles/theme.css` maps Starlight's color variables onto the dashboard's light and dark tokens (`apps/web/src/styles.css`) and its fonts. It follows the OS by default and the header has a theme picker.

## Deploys

Workers Builds on the `relayrunner-docs` Worker:

| Setting                      | Value                                               |
| ---------------------------- | --------------------------------------------------- |
| Root directory               | `/`                                                 |
| Build command                | (empty; the deploy commands build)                  |
| Deploy command               | `pnpm run deploy:docs`                              |
| Preview command              | `pnpm run deploy:docs:preview` (`wrangler preview`) |
| Non-production branch builds | on                                                  |
| Build watch paths            | include `apps/docs/*`                               |

Branch previews are public at `<branch>-relayrunner-docs.relayrun.workers.dev/docs/`. Node comes from the repo's `.nvmrc`; Astro needs 22.23.4 or newer.
