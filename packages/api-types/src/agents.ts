// Coding agents a workflow run can come from. The API labels a run with one when it's stored, from
// the GitHub account that started it or a trailer in its head commit's message, and at read time
// from its branch name (apps/api/src/reports/run-filters.ts).

export type AgentId = "claude" | "codex" | "copilot" | "cursor" | "devin" | "jules" | "aider";

export interface Agent {
  id: AgentId;
  name: string;
  /** GitHub logins the agent pushes or opens pull requests as, lowercased. */
  logins: readonly string[];
  /** What its commits carry in their message: a co-author trailer or a "generated with" line. */
  trailers: readonly RegExp[];
  /** Branch names it creates start with one of these. */
  branchPrefixes: readonly string[];
}

const coAuthor = (name: string) => new RegExp(`^co-authored-by:\\s*${name}\\b`, "im");

export const AGENTS: readonly Agent[] = [
  {
    id: "claude",
    name: "Claude",
    logins: ["claude[bot]"],
    trailers: [coAuthor("claude"), /generated with \[?claude code/i],
    branchPrefixes: ["claude/"],
  },
  {
    id: "codex",
    name: "Codex",
    logins: ["chatgpt-codex-connector[bot]"],
    trailers: [coAuthor("codex")],
    branchPrefixes: ["codex/"],
  },
  {
    id: "copilot",
    name: "Copilot",
    logins: ["copilot", "copilot-swe-agent[bot]"],
    trailers: [coAuthor("copilot")],
    branchPrefixes: ["copilot/"],
  },
  {
    id: "cursor",
    name: "Cursor",
    logins: ["cursor[bot]", "cursor-agent[bot]"],
    trailers: [coAuthor("cursor")],
    branchPrefixes: ["cursor/"],
  },
  {
    id: "devin",
    name: "Devin",
    logins: ["devin-ai-integration[bot]"],
    trailers: [coAuthor("devin")],
    branchPrefixes: ["devin/"],
  },
  {
    id: "jules",
    name: "Jules",
    logins: ["google-labs-jules[bot]"],
    trailers: [coAuthor("jules")],
    branchPrefixes: [],
  },
  {
    id: "aider",
    name: "Aider",
    logins: [],
    trailers: [coAuthor("aider"), /^aider:/im],
    branchPrefixes: [],
  },
];

const BY_ID = new Map(AGENTS.map((agent) => [agent.id, agent]));

export const agentById = (id: string): Agent | undefined => BY_ID.get(id as AgentId);

/**
 * The agent a run came from by what it says outright: the account that started it, else its head
 * commit's message. Null when neither names one.
 */
export function explicitAgent(
  logins: readonly (string | null | undefined)[],
  message: string | null | undefined,
): AgentId | null {
  const lower = logins.flatMap((login) => (login ? [login.toLowerCase()] : []));
  for (const agent of AGENTS)
    if (agent.logins.some((login) => lower.includes(login))) return agent.id;
  if (message)
    for (const agent of AGENTS)
      if (agent.trailers.some((trailer) => trailer.test(message))) return agent.id;
  return null;
}

/** The agent a branch name suggests, which is only a guess: people can name branches anything. */
export function branchAgent(branch: string | null | undefined): AgentId | null {
  if (!branch) return null;
  const lower = branch.toLowerCase();
  return (
    AGENTS.find((agent) => agent.branchPrefixes.some((prefix) => lower.startsWith(prefix)))?.id ??
    null
  );
}

/** A run's agent: `likely` when only its branch name points to it. */
export type RunAgent = { id: AgentId; likely: boolean };

export function runAgent(
  stored: string | null | undefined,
  branch: string | null | undefined,
): RunAgent | null {
  if (stored && agentById(stored)) return { id: stored as AgentId, likely: false };
  const guess = branchAgent(branch);
  return guess ? { id: guess, likely: true } : null;
}
