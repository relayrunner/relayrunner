// A repo's RelayRunner settings: `relayrunner.yml` in `.github/` or at the repo root, read from the
// default branch so a pull request can't change the checks it gets. The App can read only these
// two files (single-file Contents permission). No file means no checks.
//
// Both GitHub Apps read this one file: the main App runs `pr-title`, the opt-in Checks App runs
// `lint`. The schema stays strict and knows every key, so a typo is reported instead of ignored.
//
//   checks:
//     pr-title: true            # or { types: [feat, fix, docs] } to narrow the allowed types
//     lint: [oxlint, oxfmt]     # or { tools: [oxlint], paths: ["apps/**"] } to scope it

import { parse } from "yaml";
import { z } from "zod";
import { LINT_TOOLS, type LintTool } from "@relayrunner/lint-runner/protocol";
import { repoFile } from "./github-app.ts";

// The first one found wins.
export const CONFIG_PATHS = [".github/relayrunner.yml", "relayrunner.yml"] as const;

const typeList = z
  .union([z.array(z.string()), z.string()])
  .transform((value) =>
    (Array.isArray(value) ? value : value.split(/[,\n]/))
      .map((type) => type.trim())
      .filter(Boolean),
  );

const lintTools = z.array(z.enum(LINT_TOOLS)).min(1);

const schema = z
  .object({
    checks: z
      .object({
        "pr-title": z
          .union([z.boolean(), z.object({ types: typeList.optional() }).strict()])
          .optional(),
        lint: z
          .union([
            lintTools,
            z.object({ tools: lintTools, paths: z.array(z.string()).optional() }).strict(),
          ])
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .nullable();

export interface LintConfig {
  tools: LintTool[];
  // Glob patterns of the files to lint. Empty lints the whole repo.
  paths: string[];
}

// `prTitle` and `lint` are null when that check is off.
export type ConfigResult =
  | { kind: "none" }
  | {
      kind: "config";
      path: string;
      prTitle: { types: string[] } | null;
      lint: LintConfig | null;
    }
  | { kind: "invalid"; path: string; error: string };

/** Parses a relayrunner.yml. An empty file is valid and turns everything off. */
export function parseRepoConfig(path: string, text: string): ConfigResult {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    return { kind: "invalid", path, error: error instanceof Error ? error.message : String(error) };
  }
  const result = schema.safeParse(data ?? null);
  if (!result.success)
    return {
      kind: "invalid",
      path,
      error: result.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    };
  const prTitle = result.data?.checks?.["pr-title"];
  const lint = result.data?.checks?.lint;
  return {
    kind: "config",
    path,
    prTitle: !prTitle ? null : { types: prTitle === true ? [] : (prTitle.types ?? []) },
    lint: !lint
      ? null
      : Array.isArray(lint)
        ? { tools: dedupe(lint), paths: [] }
        : { tools: dedupe(lint.tools), paths: lint.paths ?? [] },
  };
}

function dedupe<T>(values: T[]) {
  return [...new Set(values)];
}

/** The repo's config from its default branch. */
export async function loadRepoConfig(token: string, repo: string): Promise<ConfigResult> {
  for (const path of CONFIG_PATHS) {
    const text = await repoFile(token, repo, path);
    if (text !== null) return parseRepoConfig(path, text);
  }
  return { kind: "none" };
}
