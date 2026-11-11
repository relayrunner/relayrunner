---
title: Workspaces and members
description: Your team, its roles, and the GitHub accounts it connects.
---

A workspace is your team in RelayRunner. It holds your machines, runner order, activity and members, and connects one or more GitHub accounts.

## GitHub accounts

A workspace connects GitHub organizations and personal accounts through the RelayRunner GitHub App. Each account belongs to one workspace. See and add them under **Settings → GitHub accounts**.

If the App was installed by someone who isn't an org owner, GitHub sends the owners a request. Jobs start routing once an owner accepts it.

Organizations and personal accounts both work. A few things only work for organizations, such as [adding existing runners](/docs/runners/self-hosted/#runners-your-org-already-has).

## Roles

|                                                  | Member | Admin | Owner |
| ------------------------------------------------ | ------ | ----- | ----- |
| Connect, pause and share their own machines      | ✓      | ✓     | ✓     |
| Pause any machine                                | ✓      | ✓     | ✓     |
| See activity, runs and usage                     | ✓      | ✓     | ✓     |
| Remove any machine                               |        | ✓     | ✓     |
| Change the runner order                          |        | ✓     | ✓     |
| Connect GitHub accounts and add existing runners |        | ✓     | ✓     |
| Invite and remove members                        |        | ✓     | ✓     |
| Make someone an owner                            |        |       | ✓     |

## Members

Invite people by email under **Settings → Members**, and pick their role. They get an email with a link to join.

When someone leaves or is removed, their machines are removed with them.

## More than one workspace

You can belong to several workspaces and switch between them from the workspace menu at the top of the sidebar. A machine belongs to one workspace.

## Emails

RelayRunner sends a few service emails from `noreply@send.relayrunner.app`, and never marketing email.

| Email                       | Sent to                    | When                                                                                                              |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Welcome                     | You                        | You sign up.                                                                                                      |
| Invitation                  | The person invited         | Someone invites them to a workspace.                                                                              |
| New machine connected       | The person who approved it | A machine signs in to your workspace.                                                                             |
| Machine signed in elsewhere | The person who approved it | A machine's token signs in from another network while the machine is online. Remove the machine if it wasn't you. |

Everything else, such as routing decisions and failed relays, is on the **Activity** page. A failed relay also fails its job on GitHub, so it shows up wherever you already get CI failures.
