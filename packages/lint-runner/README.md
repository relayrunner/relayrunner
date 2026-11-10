# @relayrunner/lint-runner

The container that runs lint for the RelayRunner Checks App, and the protocol the API uses to talk to it.

The API's `LintRunner` Durable Object starts this container (a Cloudflare Container, `standard-1`) with no internet access, POSTs the commit's tarball to `/lint` with the tools and paths in the query string, and gets one `LintResult` per tool back. It then turns each result into a `Lint / <tool>` check run with up to 50 annotations. See [`apps/api`](../../apps/api#lint) for how a repo turns lint on.

## Tools

oxlint, oxfmt, ruff, actionlint, zizmor, shellcheck and typos. They're all installed in the image (`Dockerfile`), so nothing downloads at lint time. Tools run one at a time, since the container has half a vCPU, and a tool still running after five minutes is stopped and reported as errored.

## Files

- `src/protocol.ts` (exported as `@relayrunner/lint-runner/protocol`): the port, `LINT_TOOLS`, and the `LintResult` and `Problem` types. `relayrunner.yml`'s `checks.lint` accepts exactly the tools listed here.
- `src/server.ts`: the HTTP server the container runs. Node runs it as TypeScript directly (type stripping), so it uses no TypeScript-only syntax.
- `src/parse.ts`: turns each tool's output into problems: GitHub workflow commands, gcc-style lines, or oxfmt's list of files.
- `Dockerfile`: the image. `apps/api/wrangler.jsonc` points at it, and deploying the API builds and pushes it when anything in this folder changed (and then needs Docker).

## Adding a tool

Install it in the `Dockerfile`, add it to `LINT_TOOLS`, describe how to run it in `src/server.ts` and how to read its output in `src/parse.ts`, with a test in `src/parse.test.ts`.
