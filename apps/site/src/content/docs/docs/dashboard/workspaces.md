---
title: Workspaces and members
description: One workspace per GitHub install, its roles, and where members come from.
---

A workspace is one install of the RelayRunner GitHub App. Install it on an organization or personal account and that account becomes a workspace, named after it, with its own runner order, activity and members. Your machines aren't tied to one: each takes your jobs in every workspace you're in.

## GitHub installation

Installing the App makes the workspace, and the person who installed it is its owner. **Settings → GitHub** links to the install on GitHub, where you choose which repos RelayRunner sees. Uninstalling the App deletes the workspace.

If the App was installed by someone who isn't an org owner, GitHub sends the owners a request. The workspace appears once an owner accepts it.

Organizations and personal accounts both work. A few things only work for organizations, such as [adding existing runners](/docs/runners/self-hosted#runners-your-org-already-has).

## Roles

|                                             | Member | Admin | Owner |
| ------------------------------------------- | ------ | ----- | ----- |
| Connect, pause and share their own machines | ✓      | ✓     | ✓     |
| Pause any machine                           | ✓      | ✓     | ✓     |
| See activity, runs and usage                | ✓      | ✓     | ✓     |
| Remove any machine                          |        | ✓     | ✓     |
| Change the runner order                     |        | ✓     | ✓     |
| Add existing runners                        |        | ✓     | ✓     |
| Make someone an admin                       |        | ✓     | ✓     |
| Make someone an owner                       |        |       | ✓     |

## Members

Membership comes from GitHub. Anyone who can see the workspace's installation on GitHub joins as a member when they sign in to RelayRunner, and leaves when GitHub stops showing it to them, for example when they leave the org. There are no invites: to add someone, give them access to the org on GitHub. Owners and admins change roles under **Settings → Members**.

Leaving a workspace doesn't remove your machines. They stop taking that workspace's jobs and keep working in your other workspaces.

## More than one workspace

Each install is its own workspace, so installing the App on another org adds one. Use **Add an organization** in the workspace menu at the top of the sidebar, and switch between workspaces there too. A machine you connect is in all of them.

## Emails

RelayRunner sends a few service emails from `noreply@send.relayrunner.app`, and never marketing email.

| Email                       | Sent to                    | When                                                                                                              |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Welcome                     | You                        | You sign up.                                                                                                      |
| New machine connected       | The person who approved it | You connect a new machine.                                                                                        |
| Machine signed in elsewhere | The person who approved it | A machine's token signs in from another network while the machine is online. Remove the machine if it wasn't you. |

Everything else, such as routing decisions and failed relays, is on the **Activity** page. A failed relay also fails its job on GitHub, so it shows up wherever you already get CI failures.
