// The landing page as Markdown, for agents. The Worker serves it for / when a request asks for
// `Accept: text/markdown` (worker/index.ts). Keep it in step with index.astro's sections.
import type { APIRoute } from "astro";
import { setupPrompt } from "../lib/agent-setup";
import { CHANGELOG_ID, latestUpdates } from "../lib/changelog";
import { KNOWN_PROVIDERS, PROVIDERS } from "../lib/providers";

export const GET: APIRoute = async ({ site }) => {
  const abs = (path: string) => new URL(path, site).href;
  const updates = latestUpdates(6)
    .map(
      (update) =>
        `- ${update.date.toISOString().slice(0, 10)}: [${update.title}](${abs(update.href)}) (${update.type})`,
    )
    .join("\n");
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
${setupPrompt(site!)}
\`\`\`

## Your machines

Run \`npx relayrunner connect\` on a laptop, Mac mini or home server and it starts taking jobs. Close the lid and jobs go to the next runner in your order. With automatic retries on, a job cut off mid-run starts again on the next free runner. Share it with your team or keep it private.

On a Mac, [RelayRunner for Mac](${abs("/docs/get-started/mac-app")}) does the same from the menu bar with one switch. [Download it](${abs("/download")}) or run \`brew install --cask relayrunner/tap/relayrunner\`.

## Providers

Each provider is a step in your runner order. Add, reorder or remove them in the dashboard. Supported: ${providers}.

## Switch

Try a new provider, move work onto your machines, or send everything back to GitHub. You change the order in the dashboard, without a commit or pull request, and it applies to the next job.

Runner sizes work the same way. Move a job from 2 vCPU to 4 on the Router page, and its next run gets the bigger runner on whichever provider takes it.

## Minutes

Set a cap on GitHub-hosted as a share of the minutes your plan includes. Once you reach it, jobs go to the next runner in your order.

## Compare

Every job shows where it ran and why. See how long the same job takes on each runner, and how much you use each provider.

Signals point out what makes CI slow or costly, like flaky jobs and long waits for a runner, and History says why each failed job failed.

## Optimized checks

PR title and lint checks (oxlint, ruff, actionlint and more) finish in seconds, but a hosted runner bills each one as a full minute. Optimized checks need no runner, post results to your pull request and use no minutes.

## Telemetry

Each workflow run goes out as an OpenTelemetry trace: its jobs and steps, where each job ran and how long it waited for a runner. Honeycomb, Grafana, Axiom or your own collector read it as is. Send job logs alongside, or archive them to your own bucket. See [Telemetry](${abs("/docs/dashboard/telemetry")}).

## Agents

Connect the [MCP server](${abs("/docs/reference/mcp")}) to Claude, Cursor or VS Code. Your agent sees your runners, runs, failures and usage. Where you allow it, it can also change the runner order, pause a runner or set a job's size, and every change shows in Activity.

## Security

- Hosted runners stay as the fallback: if your machine is offline, the job runs on the next runner in your order.
- Public repos don't use your machines: code from a stranger's pull request never runs on your computer.
- Shared machines follow repo access: a shared machine only takes jobs from repos its owner can read.
- Jobs fail with a reason: if no runner can take a job, it fails right away and your pull request's checks say why.

## What's new

${updates}

See the [changelog](${abs(`/${CHANGELOG_ID}`)}) for every update and release.

## Links

- [Docs](${abs("/docs")})
- [Docs for agents (llms.txt)](${abs("/llms.txt")})
- [MCP server](${abs("/docs/reference/mcp")})
- [API](${abs("/docs/reference/api")}) and its [OpenAPI spec](${abs("/openapi.json")})
- [CLI](${abs("/docs/reference/cli")}) ([npm](https://www.npmjs.com/package/relayrunner))
- [Mac app](${abs("/docs/get-started/mac-app")}) ([download](${abs("/download")}))
- [GitHub](https://github.com/relayrunner/relayrunner)
- [GitHub App](https://github.com/apps/relayrunner)
`;
  return new Response(body, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
};
