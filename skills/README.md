# Agent skills

Skills that teach coding agents to use RelayRunner: `relayrunner` for the CLI, `relayrunner-route-jobs` for routing a repo's jobs, and `relayrunner-ci-insights` for reading your CI through the MCP server. Install them with the [skills CLI](https://skills.sh):

```sh
npx skills add relayrunner/relayrunner
```

See [Set up with an agent](https://relayrunner.app/docs/get-started/agents#install-the-skills) for what each one does. The [MCP server](https://relayrunner.app/docs/reference/mcp#skills) serves the same files at `skill://<name>/SKILL.md`, so a new file here also needs a line in `apps/agents/src/skills.ts`.

These are for people who use RelayRunner; skills for working on this repo live in `.agents/skills`.
