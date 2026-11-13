// The landing page as Markdown, for agents. The Worker serves it for / when a request asks for
// `Accept: text/markdown` (worker/index.ts). Keep it in step with index.astro's sections.
import type { APIRoute } from "astro";
import { KNOWN_PROVIDERS, PROVIDERS } from "../lib/providers";

export const GET: APIRoute = ({ site }) => {
  const abs = (path: string) => new URL(path, site).href;
  const providers = KNOWN_PROVIDERS.map((id) => PROVIDERS[id].name).join(", ");
  const body = `# RelayRunner: one router for every CI runner

> Send each GitHub Actions job to the first free runner in your order: your own machines, self-hosted runners, a hosted provider, or GitHub-hosted. You change the order in the dashboard, not in your workflows.

RelayRunner is open source. Turn any Mac or Linux computer into a runner with one command:

\`\`\`sh
npx relayrunner connect
\`\`\`

Then, in your repo, pick the jobs to route:

\`\`\`sh
npx relayrunner init
\`\`\`

Or paste this into Claude Code, Codex or Cursor and your agent does the setup:

\`\`\`text
Set up relayrunner in this checkout using https://raw.githubusercontent.com/relayrunner/relayrunner/main/docs/agent-install.md
\`\`\`

## Your machines

Run \`npx relayrunner connect\` on a laptop, Mac mini or home server and it starts taking jobs. Close the lid and jobs go to the next runner in your order. Share it with your team or keep it private.

## Providers

Each provider is a step in your runner order. Add, reorder or remove them in the dashboard. Supported: ${providers}.

## Switch

Try a new provider, move work onto your machines, or send everything back to GitHub. You change the order in the dashboard, without a commit or pull request, and it applies to the next job.

## Minutes

Set a cap on GitHub-hosted as a share of the minutes your plan includes. Once you reach it, jobs go to the next runner in your order.

## Compare

Every job shows where it ran and why. See how long the same job takes on each runner, and how much you use each provider.

## Optimized checks

PR title and lint checks (oxlint, ruff, actionlint and more) finish in seconds, but a hosted runner bills each one as a full minute. Optimized checks need no runner, post results to your pull request and use no minutes.

## Security

- Hosted runners stay as the fallback: if your machine is offline, the job runs on the next runner in your order.
- Public repos don't use your machines: code from a stranger's pull request never runs on your computer.
- Shared machines follow repo access: a shared machine only takes jobs from repos its owner can read.
- Jobs fail with a reason: if no runner can take a job, it fails and tells you why instead of waiting in the queue.

## Links

- [Docs](${abs("/docs")})
- [Docs for agents (llms.txt)](${abs("/llms.txt")})
- [MCP server](${abs("/docs/reference/mcp")})
- [API](${abs("/docs/reference/api")}) and its [OpenAPI spec](${abs("/openapi.json")})
- [CLI](${abs("/docs/reference/cli")}) ([npm](https://www.npmjs.com/package/relayrunner))
- [GitHub](https://github.com/relayrunner/relayrunner)
- [GitHub App](https://github.com/apps/relayrunner)
`;
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
