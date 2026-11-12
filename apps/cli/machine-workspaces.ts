// Which of its owner's workspaces a machine runs jobs in (#362, #366): `relayrunner workspaces`,
// `workspaces add <name>` and `workspaces remove <name>`. GET /api/machines/me/workspaces answers
// with the ones it's in (`workspaces`) and the owner's other ones (`others`); PUT and DELETE
// /api/machines/me/workspaces/:workspaceId add and remove one, answering the same way. All with
// the machine token, logged as the machine's owner.

import { z } from "zod";
import { userAgent } from "./paths.ts";
import { sharingMeaning, toChoice } from "./share.ts";

const Choice = z.object({
  id: z.string().min(1),
  name: z.string(),
  slug: z.string().nullish(),
});
export type WorkspaceChoice = z.infer<typeof Choice>;

export const MachineWorkspaces = z.object({
  machine: z.object({
    id: z.string().min(1),
    name: z.string(),
    sharing: z.enum(["only_me", "anyone"]),
  }),
  workspaces: z.array(Choice),
  others: z.array(Choice),
});
export type MachineWorkspaces = z.infer<typeof MachineWorkspaces>;

export type MachineWorkspacesResult =
  | { status: "ok"; choice: MachineWorkspaces }
  // The token is unknown or the machine was removed.
  | { status: "revoked" }
  // The owner isn't a member of that workspace (any more).
  | { status: "not_found" }
  | { status: "failed"; reason: string };

/** GET the machine's workspaces, or PUT/DELETE one of them when `change` is given. */
export async function machineWorkspaces(options: {
  server: string;
  token: string;
  change?: { action: "add" | "remove"; workspaceId: string };
  fetcher?: typeof fetch;
}): Promise<MachineWorkspacesResult> {
  const fetcher = options.fetcher ?? fetch;
  const { change } = options;
  const path = change
    ? `/api/machines/me/workspaces/${encodeURIComponent(change.workspaceId)}`
    : "/api/machines/me/workspaces";
  let response: Response;
  try {
    response = await fetcher(new URL(path, options.server), {
      method: change ? (change.action === "add" ? "PUT" : "DELETE") : "GET",
      headers: { authorization: `Bearer ${options.token}`, "user-agent": userAgent },
    });
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause?.message;
    return {
      status: "failed",
      reason: `couldn't reach ${options.server}${cause ? ` (${cause})` : ""}`,
    };
  }
  if (response.status === 401) return { status: "revoked" };
  const body = await response.json().catch(() => null);
  // The route answers 404 { error: "not_found" } for a workspace the owner isn't in. Any other
  // 404, or a 405, is a gateway from before #363 that has no such route.
  if (change && response.status === 404 && (body as { error?: unknown })?.error === "not_found")
    return { status: "not_found" };
  if (response.status === 404 || response.status === 405)
    return {
      status: "failed",
      reason: `${options.server} doesn't support choosing workspaces yet`,
    };
  if (response.status === 403)
    return { status: "failed", reason: "only the machine's owner can change its workspaces" };
  if (!response.ok)
    return { status: "failed", reason: `${options.server} answered HTTP ${response.status}` };
  const parsed = MachineWorkspaces.safeParse(body);
  if (!parsed.success)
    return { status: "failed", reason: `${options.server} sent an unexpected response` };
  return { status: "ok", choice: parsed.data };
}

export type Match =
  | { status: "one"; workspace: WorkspaceChoice }
  | { status: "none" }
  | { status: "several"; workspaces: WorkspaceChoice[] };

/** The workspace `query` names: its id, or its name or slug in any case. */
export function matchWorkspace(workspaces: WorkspaceChoice[], query: string): Match {
  const byId = workspaces.find((workspace) => workspace.id === query);
  if (byId) return { status: "one", workspace: byId };
  const wanted = query.trim().toLowerCase();
  const found = workspaces.filter(
    (workspace) =>
      workspace.name.toLowerCase() === wanted || workspace.slug?.toLowerCase() === wanted,
  );
  if (found.length === 1) return { status: "one", workspace: found[0]! };
  return found.length ? { status: "several", workspaces: found } : { status: "none" };
}

/** "Acme (acme)" for listing, so two workspaces with the same name can be told apart. */
export function labelWorkspace(workspace: WorkspaceChoice, withId = false) {
  const slug = workspace.slug && workspace.slug !== workspace.name ? ` (${workspace.slug})` : "";
  return `${workspace.name}${slug}${withId ? `  ${workspace.id}` : ""}`;
}

/** What `relayrunner workspaces` prints. */
export function describeMachineWorkspaces({ machine, workspaces, others }: MachineWorkspaces) {
  const lines: string[] = [];
  if (!workspaces.length && !others.length) {
    lines.push(
      `${machine.name} isn't in a workspace yet. It takes jobs once RelayRunner is installed on a GitHub account or org you belong to.`,
    );
    return lines.join("\n");
  }
  lines.push(`${machine.name} runs jobs in:`);
  if (workspaces.length) for (const w of workspaces) lines.push(`  ✓ ${labelWorkspace(w)}`);
  else lines.push("  (none: it takes no jobs)");
  if (others.length) {
    lines.push("", "Not in:");
    for (const w of others) lines.push(`  · ${labelWorkspace(w)}`);
  }
  lines.push(
    "",
    `Sharing: ${toChoice(machine.sharing)}: ${sharingMeaning(machine.sharing, "these workspaces")}`,
  );
  if (others.length) lines.push("Add one with `relayrunner workspaces add <name>`.");
  else if (workspaces.length) lines.push("Remove one with `relayrunner workspaces remove <name>`.");
  return lines.join("\n");
}

/** Said when `add` puts a machine that runs anyone's jobs into another workspace. */
export function anyoneWarning(machine: string, workspace: string) {
  return `${machine} is set to run anyone's jobs, so anyone who can push to ${workspace}'s private repos can run jobs on it. Use \`relayrunner share only-me\` to limit it to jobs you started.`;
}
