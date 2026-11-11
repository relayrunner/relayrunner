// Where a machine is: every workspace its owner is a member of (#318, #321). The gateway sends
// that list as `workspaces` when the machine signs in and from `whoami`. A gateway from before
// then sends only the single `workspace`, and a sign-in with no workspace yet sends neither, or
// `workspace: null`.

import { z } from "zod";

export const Workspace = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string().nullish(),
  // Missing from a gateway that predates #244.
  memberCount: z.number().int().nonnegative().optional(),
});
export type Workspace = z.infer<typeof Workspace>;

export const WorkspaceFields = {
  workspace: Workspace.nullish(),
  workspaces: z.array(Workspace).optional(),
};

/** The machine's workspaces, from the list or else the single `workspace` an older gateway sends. */
export function readWorkspaces(body: {
  workspace?: Workspace | null;
  workspaces?: Workspace[];
}): Workspace[] {
  return body.workspaces ?? (body.workspace ? [body.workspace] : []);
}

/** Whether anyone else is in one of them, so teammates' jobs could run on the machine. */
export function hasTeammates(workspaces: Workspace[]) {
  return workspaces.some((workspace) => (workspace.memberCount ?? 0) > 1);
}

/** "Acme", "Acme and atticoos", "Acme, Beta and atticoos". */
export function workspaceNames(workspaces: Pick<Workspace, "name">[]) {
  const names = workspaces.map((workspace) => workspace.name);
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What "anyone" reaches: the one workspace by name, or "your workspaces". */
export function sharingScope(workspaces: Pick<Workspace, "name">[]) {
  return workspaces.length === 1 ? workspaces[0]!.name : "your workspaces";
}

/** Said after signing in when the machine isn't in any workspace yet. */
export function noWorkspaceYet(machine: string, server: string) {
  return [
    `${machine} isn't in a workspace yet. It takes jobs once RelayRunner is installed on a GitHub account or org you belong to, or once an org owner accepts your install request.`,
    `Install: ${new URL("/api/github/install", server)}`,
  ].join("\n");
}
