---
title: Share your team's machines
description: Pool the team's spare computers so anyone's jobs can use them.
sidebar:
  label: Team machines
---

Most teams have computers sitting idle: a Mac mini in the office, a workstation that's off-hours half the day, last year's laptop. RelayRunner pools them, so anyone's jobs can run on whichever one is free.

## 1. Invite the team

On the dashboard, open **Settings → Members** and invite people by email. Members can connect machines, pause them and see activity. Owners and admins also manage GitHub accounts, the runner order and members.

## 2. Connect the shared machines

On each shared computer:

```sh
npx relayrunner connect --share anyone
```

**Anyone** lets the machine take any job in the workspace, including teammates' and bots'. A machine you keep for yourself stays on **only me**.

## 3. What "anyone" covers

A machine shared with anyone only takes jobs from repos its owner can open on GitHub. Being in the same workspace isn't enough. That way, connecting a machine never gives it code or secrets its owner couldn't already see.

So the person who connects a shared machine should have access to every repo you want it to serve. A team or service account works well for this.

## 4. How jobs are spread

RelayRunner sends each job to an idle machine. The machines of the person who started the job come first, then whichever one was picked least recently, so work spreads across the pool.

## Personal laptops in the pool

A teammate can connect their own laptop too, on **only me**. Their pushes use it first, and everything else uses the shared machines. If they want to help the team while they're away, they can switch it to **anyone** and back.

## When someone leaves

Remove them under **Settings → Members**. Their machines are removed from the workspace with them.
