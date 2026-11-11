# GitHub App

RelayRunner reaches GitHub mainly through one GitHub App, **RelayRunner** ([github.com/apps/relayrunner](https://github.com/apps/relayrunner), App ID in `GITHUB_APP_ID`). It does three jobs: it signs users in, it receives webhooks, and its installation tokens register runners and read billing. Lint uses a second, opt-in App, **RelayRunner Checks**, described in [apps/api/README.md](../apps/api/README.md#lint).

The App can be installed on an **organization** or a **personal account**. Both work. They differ in where runners register and how Actions minutes are read (see [Organizations and personal accounts](#organizations-and-personal-accounts)).

## Visibility

The App must be **public** (App settings → Advanced → Make public). A private GitHub App can only be installed on the account that owns it, here the `relayrunner` org, so every other org and personal account gets nowhere: "Connect another account" in the dashboard fails for them. Found in the personal account live test (#210), where `atticoos` couldn't install the App until it was made public. Public only means anyone can install it; installing still gives RelayRunner nothing until the installation is connected to a workspace.

## Permissions

These are what the code needs. When you change a permission on the App, every account that installed it has to accept the change on GitHub (Settings → Applications → Installed GitHub Apps → RelayRunner) before the new permission reaches its installation token. User permissions also need each user to sign in to RelayRunner again (see [Account permissions](#account-permissions)).

### Repository permissions

| Permission     | Access                                                             | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administration | Read & write                                                       | Pick and machine runners register on the job's repo in every account, so only that repo's jobs can reach them and no org runner group applies (`apps/api/src/repo-runner.ts`). Personal accounts have no org runners, so their container runners register there too: `POST /repos/{owner}/{repo}/actions/runners/generate-jitconfig`, plus listing and deleting them (`runnerScope` in `apps/api/src/github-app.ts`). An org installation that hasn't accepted it, or an org that only allows org-level runners, falls back to org runners and logs `relayrunner pick runner registered on the org` or `machine runner registered on the org`. |
| Actions        | Read                                                               | The `workflow_job` and `workflow_run` events, and `GET /repos/{owner}/{repo}/actions/jobs/{id}` to see whether a relay job is still queued before starting a replacement pick runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Checks         | Read & write                                                       | The PR title check, and the failed `RelayRunner` check run posted when a runner group keeps a relay job from ever reaching RelayRunner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Contents       | Read, single file: `relayrunner.yml` and `.github/relayrunner.yml` | Reads the repo's `relayrunner.yml` for the PR title check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Pull requests  | Read                                                               | The `pull_request` event for the PR title check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Metadata       | Read                                                               | Required by GitHub for every App.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### Organization permissions

| Permission          | Access       | Why                                                                                                                                                                                                                                             |
| ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Self-hosted runners | Read & write | Registers one-job runners in the org (container runners, and pick and machine runners when the repo is refused), deletes them, reads runner groups to explain blocked relays, and lists and labels existing runners an org adds to RelayRunner. |
| Administration      | Read         | Reads the org's plan, Actions billing usage and Actions budget for the minutes rule (`apps/api/src/actions-billing.ts`), when the org hasn't installed the [Spend App](#relayrunner-spend). To be removed once orgs have moved to it.           |

### Account permissions

| Permission      | Access | Why                                                                                                                                                                       |
| --------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Email addresses | Read   | The user's email at sign-in (`GET /user/emails`).                                                                                                                         |
| Plan            | Read   | A personal account's plan and Actions billing usage, for the minutes rule. GitHub only opens these to the account owner's own user token, never to an installation token. |

Account permissions apply to the user's sign-in token, not to an installation. GitHub doesn't add a new one to tokens users already hold: each user has to sign out of RelayRunner and sign in again, and approve the permission when GitHub asks. Until a personal account's owner does that, the dashboard shows that GitHub refused to share the account's billing, and the minutes rule can't be turned on for it.

### More than the code needs

The live App was set up with a few grants beyond these: Organization Administration is Read & write, Actions is Read & write, and the single-file Contents permission is Read & write. Read is enough for each. Narrowing them makes every installation re-accept the App, so it's left for a time when that's convenient.

## RelayRunner Spend

A second, opt-in App, **RelayRunner Spend** ([github.com/apps/relayrunner-spend](https://github.com/apps/relayrunner-spend), App ID in `GITHUB_SPEND_APP_ID`, key in the Secrets Store as `GITHUB_SPEND_APP_PRIVATE_KEY`), reads org billing for the minutes rule. Keeping billing in its own App means the main App doesn't need Organization Administration.

- Permissions: Organization Administration: Read, and Metadata. Nothing else.
- No webhook. The 15-minute billing poll finds the org's installation with the App's JWT (`GET /orgs/{org}/installation`) and mints a token from it, falling back to the main App's token when the org hasn't installed it.
- When the org's billing read is refused, the dashboard links to the install page.
- Personal accounts don't use it: their billing only opens to the owner's own sign-in token (Plan).

Once orgs have installed it, the main App drops Organization Administration, in the same change as narrowing the grants under [More than the code needs](#more-than-the-code-needs), so installations re-accept once.

## Events

| Event                                   | Why                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installation, Installation repositories | Sent to every App. Keep `github_installation` and `github_repository` current: account and its type, suspension, repo selection, uninstall.           |
| Repository                              | Keeps repo names and visibility current after renames, visibility changes, transfers and deletes.                                                     |
| Workflow job                            | Routing. A `queued` job on `relayrunner` starts a pick runner; a `queued` job on a route label hands it to the machine; finished jobs feed job times. |
| Workflow run                            | Run titles, triggers and status for the Runs page.                                                                                                    |
| Pull request                            | The PR title check.                                                                                                                                   |

## Sign-in

Better Auth uses the App's OAuth client as its GitHub provider (`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`), so signing in to RelayRunner is authorizing the App. The callback URL is `<BETTER_AUTH_URL>/api/auth/callback/github`. The user token from sign-in lists the user's installations when they connect one to a workspace, and reads a personal account's billing (above).

## URLs

- Webhook URL: `https://webhooks.relayrunner.app/api/webhooks/github` (the `apps/webhooks` Worker, see its [README](../apps/webhooks/README.md)).
- Callback URLs, in this order:
  1. `<BETTER_AUTH_URL>/api/github/setup`. **Request user authorization (OAuth) during installation** is on, so GitHub signs the user in as part of the install and then sends them to the _first_ callback URL (with `code` and `installation_id`, and no `state`). That has to be the setup route, which links the installation, or signs a new user in and hands them back to `/device` (`apps/api/src/routes/github.ts`).
  2. `<BETTER_AUTH_URL>/api/auth/callback/github`, where every sign-in returns. Better Auth names it explicitly, so its place in the list doesn't matter.
  3. `http://localhost:8787/api/auth/callback/github` for local development.
- Setup URL: greyed out while OAuth during installation is on; GitHub uses the first callback URL instead. **Redirect on update** stays on and goes there too.

The private key lives in the Cloudflare Secrets Store as `GITHUB_APP_PRIVATE_KEY`, in PKCS#8 form (see [apps/api/README.md](../apps/api/README.md#deploy)).

## Organizations and personal accounts

|                                | Organization                                                                                                                                                     | Personal account                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where one-job runners register | Pick and machine runners: the job's own repo, falling back to the org's Default group when refused. Container runners: the org, in Default Public when it exists | The job's own repo. Repos have no runner groups.                                                                                                    |
| Permission used                | Repository Administration, and Organization Self-hosted runners                                                                                                  | Repository Administration                                                                                                                           |
| Runner group checks            | Only on the org fallback: the pick checks Default allows the repo, and says why when it doesn't                                                                  | None                                                                                                                                                |
| Public repos                   | Relay jobs are answered (on the org fallback, only if Default allows public repos). Never on machines.                                                           | Relay jobs are answered. Never on machines.                                                                                                         |
| Existing self-hosted runners   | Can be added to RelayRunner                                                                                                                                      | Not yet (#162)                                                                                                                                      |
| Actions minutes                | Read with the installation token (Organization Administration)                                                                                                   | Read with the owner's sign-in token (Plan). The owner must be a member of the workspace and have signed in since Plan was added. No budget is read. |
| Leftover pick runner sweep     | Each repo that had a relay job in the last day, and each org                                                                                                     | Each repo that had a relay job in the last day                                                                                                      |

RelayRunner learns which kind an installation is from its `installation` webhook (`github_installation.account_type`). An installation it hasn't recorded is treated as an org.
