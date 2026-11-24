import {
  CLIENT_CAPABILITIES_META_KEY,
  type ClientCapabilities,
  type InputRequiredResult,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { AppError, describeError } from "@relayrunner/errors";
import { z } from "zod";
import type { Workspace, WorkspaceApi } from "./api.ts";

// What every tool needs, built once per request in index.ts: the API as the agent, the
// connection's workspaces, and how a call's `workspace` argument resolves to one of them.

type Result = { content: { type: "text"; text: string }[]; isError?: boolean };

// API errors, and calls the model can fix itself (such as naming a workspace), come back as tool
// errors the model can read and act on, not protocol errors: the message, then the code. Answers
// are unindented JSON: every byte counts against the client's tool-result cap. A question for the
// person (confirmFirst) goes out as it is.
export async function answer(read: () => Promise<unknown>): Promise<Result | InputRequiredResult> {
  try {
    const value = await read();
    if (isInputRequiredResult(value)) return value;
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
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

/**
 * Asks the person before a change that stops or drops something, on clients that can show a
 * form (MCP elicitation). Answers nothing when the change may go ahead, the question to send, or
 * what to tell the model when the person says no. Only the 2026-07-28 revision can ask: it sends
 * the question as the call's answer and the client calls again with the reply. The 2025 path here
 * answers plain JSON with no way to ask mid-call, so there the tool annotations and the server
 * instructions still ask the client to check first. The reply comes from the client, like the
 * call itself: this is a check for the person, not an authorization (the API does that).
 */
export function confirmFirst(ctx: ServerContext, message: string) {
  // The SDK types the envelope as {}, though it carries these keys.
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
  const elicitation = declared?.elicitation;
  // `elicitation: {}` means form mode; a client may also declare only URL mode.
  if (!elicitation || (elicitation.url && !elicitation.form)) return;
  const reply = inputResponse(ctx.mcpReq.inputResponses, "confirm");
  if (reply.kind === "missing") {
    return inputRequired({
      inputRequests: {
        confirm: inputRequired.elicit({
          message,
          requestedSchema: { type: "object", properties: {} },
        }),
      },
    });
  }
  if (reply.kind === "elicit" && reply.action === "accept") return;
  return { changed: false, message: "The person said no, so nothing changed." };
}

export interface ToolContext {
  request: WorkspaceApi;
  workspaces: Workspace[];
  /** The workspace a call names (by id or name), or the connection's only one. */
  workspaceId: (workspace: string | undefined) => string;
  /** A /workspaces/:id path, for the workspace a call names. */
  workspacePath: (workspace: string | undefined, path: string) => string;
  /** The name of the workspace a call names, for questions to the person. */
  workspaceName: (workspace: string | undefined) => string;
}

export function toolContext(request: WorkspaceApi, workspaces: Workspace[]): ToolContext {
  const named = (workspace: string | undefined) => {
    if (workspace) {
      return findNamed(workspaces, workspace, { noun: "workspace", listTool: "list_workspaces" });
    }
    if (workspaces.length === 1) return workspaces[0];
    throw new AppError("WORKSPACE_REQUIRED", {
      message: `This connection reads ${workspaces.length} workspaces. Pass workspace (an id or name from list_workspaces).`,
    });
  };
  const workspaceId = (workspace: string | undefined) => named(workspace).id;
  return {
    request,
    workspaces,
    workspaceId,
    workspacePath: (workspace, path) =>
      `/workspaces/${encodeURIComponent(workspaceId(workspace))}/${path}`,
    workspaceName: (workspace) => named(workspace).name,
  };
}
