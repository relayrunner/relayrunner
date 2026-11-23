import { AppError, describeError } from "@relayrunner/errors";
import { z } from "zod";
import type { Workspace, WorkspaceApi } from "./api.ts";

// What every tool needs, built once per request in index.ts: the API as the agent, the
// connection's workspaces, and how a call's `workspace` argument resolves to one of them.

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

// API errors, and calls the model can fix itself (such as naming a workspace), come back as tool
// errors the model can read and act on, not protocol errors: the message, then the code. Answers
// are unindented JSON: every byte counts against the client's tool-result cap.
export async function answer(read: () => Promise<unknown>): Promise<Result> {
  try {
    return { content: [{ type: "text", text: JSON.stringify(await read()) }] };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { content: [{ type: "text", text: describeError(error) }], isError: true };
  }
}

export const workspaceArg = z
  .string()
  .optional()
  .describe(
    "Which workspace, by id or name (see list_workspaces). Needed only when this connection reads more than one.",
  );

export const repositoryArg = z
  .string()
  .optional()
  .describe("A repository in the workspace, as owner/name, for its own runner order.");

/** The item `query` names, by id or name (any case). NOT_FOUND names `listTool` to look in. */
export function findNamed<T extends { id: string; name: string }>(
  items: T[],
  query: string,
  { noun, listTool }: { noun: string; listTool: string },
): T {
  const named = items.filter(
    ({ id, name }) => id === query || name.toLowerCase() === query.toLowerCase(),
  );
  if (named.length === 1) return named[0];
  throw new AppError("NOT_FOUND", {
    message:
      named.length === 0
        ? `No ${noun} "${query}". See ${listTool}.`
        : `More than one ${noun} is named "${query}". Pass its id from ${listTool}.`,
  });
}

export interface ToolContext {
  request: WorkspaceApi;
  workspaces: Workspace[];
  /** The workspace a call names (by id or name), or the connection's only one. */
  workspaceId: (workspace: string | undefined) => string;
  /** A /workspaces/:id path, for the workspace a call names. */
  workspacePath: (workspace: string | undefined, path: string) => string;
}

export function toolContext(request: WorkspaceApi, workspaces: Workspace[]): ToolContext {
  const workspaceId = (workspace: string | undefined) => {
    if (workspace) {
      return findNamed(workspaces, workspace, { noun: "workspace", listTool: "list_workspaces" })
        .id;
    }
    if (workspaces.length === 1) return workspaces[0].id;
    throw new AppError("WORKSPACE_REQUIRED", {
      message: `This connection reads ${workspaces.length} workspaces. Pass workspace (an id or name from list_workspaces).`,
    });
  };
  return {
    request,
    workspaces,
    workspaceId,
    workspacePath: (workspace, path) =>
      `/workspaces/${encodeURIComponent(workspaceId(workspace))}/${path}`,
  };
}
