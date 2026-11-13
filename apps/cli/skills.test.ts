import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { ArgsDef, CommandDef } from "citty";
import { expect, test } from "vitest";
import { main } from "./main.ts";
import { RELAY_REF } from "./workflows.ts";

// The agent skills in skills/ (installed with `npx skills add relayrunner/relayrunner`) and the
// agent guide tell agents which commands and flags to run. This fails when one names a command
// or flag the CLI doesn't have, or a relay version init no longer writes.

type Command = CommandDef<ArgsDef>;
// Every command in the tree defines args and subCommands as plain objects, not lazy loaders.
const args = (command: Command) => (command.args ?? {}) as ArgsDef;
const subCommands = (command: Command) =>
  command.subCommands as Record<string, Command> | undefined;

const repo = new URL("../../", import.meta.url);
const skills = new URL("skills/", repo);
const files = [
  "docs/agent-install.md",
  ...readdirSync(skills, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/SKILL.md`, skills)))
    .flatMap((entry) =>
      readdirSync(new URL(`${entry.name}/`, skills), { recursive: true, encoding: "utf8" })
        .filter((path) => path.endsWith(".md"))
        .map((path) => `skills/${entry.name}/${path}`),
    ),
];

// Every flag any command takes, for flags a skill names on their own (`--cpus <n>`).
const allFlags = new Set(["help", "version"]);
(function walk(command: Command) {
  for (const [name, arg] of Object.entries(args(command))) {
    allFlags.add(name);
    if (arg.type === "boolean") allFlags.add(`no-${name}`);
  }
  for (const sub of Object.values(subCommands(command) ?? {})) walk(sub);
})(main as Command);

// Code the file shows: fenced blocks and inline code spans.
function code(text: string) {
  const fenced = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]!);
  const prose = text.replace(/```[\s\S]*?```/g, "");
  const inline = [...prose.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
  return [...fenced, ...inline];
}

// What's wrong with one `relayrunner <words> --flags` line, if anything.
function check(tokens: string[]) {
  let command = main as Command;
  let path = "relayrunner";
  let rest = tokens;
  while (subCommands(command) && /^[a-z]/.test(rest[0] ?? "")) {
    const word = rest[0]!;
    const next = subCommands(command)![word];
    if (!next) return `${path} has no command ${word}`;
    [command, path, rest] = [next, `${path} ${word}`, rest.slice(1)];
  }
  const fallback = command.default as string | undefined;
  if (fallback) command = subCommands(command)![fallback]!;
  for (const token of rest.filter((token) => token.startsWith("--"))) {
    const flag = token.slice(2).split("=")[0]!;
    if (flag === "help" || flag === "version") continue;
    const own = args(command);
    if (!own[flag] && own[flag.slice(3)]?.type !== "boolean") return `${path} has no --${flag}`;
  }
  return null;
}

test.each(files)("%s matches the CLI", (path) => {
  const text = readFileSync(new URL(path, repo), "utf8");
  const problems: string[] = [];
  for (const snippet of code(text)) {
    // A line that runs relayrunner (or `npx relayrunner@latest …`), up to a comment or pipe.
    for (const match of snippet.matchAll(
      /^\s*(?:npx +)?relayrunner(?:@[\w.-]+)?((?: +[^\s#|;`]+)+)/gm,
    )) {
      const tokens = match[1]!.trim().split(/ +/);
      const problem = check(tokens);
      if (problem) problems.push(`${problem}: relayrunner ${tokens.join(" ")}`);
    }
    const flag = /^--([a-z][\w-]*)/.exec(snippet)?.[1];
    if (flag && !allFlags.has(flag)) problems.push(`no command has --${flag}`);
  }
  for (const [, version] of text.matchAll(/(?:relay\.yml@|"relay": ")(v[\w.-]+)/g))
    if (version !== RELAY_REF) problems.push(`relay ${version} isn't ${RELAY_REF}`);
  expect(problems).toEqual([]);
});
