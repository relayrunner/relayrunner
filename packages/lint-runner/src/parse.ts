// Turns each tool's output into Problems. Most tools can print GitHub's workflow commands
// (`::error file=…,line=…::message`); shellcheck and typos print gcc-style `path:line:col: level:
// message` lines; oxfmt lists the files it would reformat.

import type { Problem, ProblemLevel } from "./protocol.ts";

const COMMAND = /^::(error|warning|notice)(?: (.*?))?::(.*)$/;

/** Problems from GitHub workflow commands. Paths are made relative to `root`. */
export function parseWorkflowCommands(output: string, root: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of output.split("\n")) {
    const match = COMMAND.exec(line.trim());
    if (!match) continue;
    const props = parseProperties(match[2] ?? "");
    if (!props.file) continue;
    const path = relativePath(props.file, root);
    problems.push({
      path,
      line: positive(props.line) ?? 1,
      endLine: positive(props.endLine),
      column: positive(props.col),
      endColumn: positive(props.endColumn),
      level: match[1] as ProblemLevel,
      title: props.title || undefined,
      message: stripPrefixes(unescapeData(match[3]), path, props.title),
    });
  }
  return problems;
}

const GCC = /^(.+?):(\d+):(\d+): (error|warning|note|info|style): (.*)$/;

/**
 * Problems from gcc-style lines. shellcheck's warnings fail its own run, so `warning` counts as
 * an error; info and style are notices.
 */
export function parseGccLines(output: string, root: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of output.split("\n")) {
    const match = GCC.exec(line.trim());
    if (!match) continue;
    const [, file, row, column, severity, text] = match;
    const rule = /\s*\[(SC\d+)\]$/.exec(text);
    problems.push({
      path: relativePath(file, root),
      line: Number(row),
      column: Number(column),
      level: severity === "error" || severity === "warning" ? "error" : "notice",
      title: rule?.[1],
      message: rule ? text.slice(0, rule.index) : text,
    });
  }
  return problems;
}

/** One problem per file `oxfmt --check` would reformat. It lists them as `path (3ms)`. */
export function parseOxfmtCheck(output: string): Problem[] {
  return output
    .split("\n")
    .map((line) => /^(\S.*?) \(\d+(?:\.\d+)?m?s\)$/.exec(line.trim())?.[1])
    .filter((path): path is string => Boolean(path))
    .map((path) => ({
      path,
      line: 1,
      level: "error" as const,
      title: "oxfmt",
      message: "This file isn't formatted. Run `oxfmt` to fix it.",
    }));
}

/** A matcher for `paths` globs: `**` spans directories, `*` and `?` stay inside one. */
export function pathMatcher(globs: string[]): (path: string) => boolean {
  if (globs.length === 0) return () => true;
  const patterns = globs.map((glob) => {
    let source = "";
    const text = glob.replace(/^\.?\//, "");
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === "*" && text[i + 1] === "*") {
        // `**/` also matches no directories at all.
        const slash = text[i + 2] === "/";
        source += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else if (char === "*") source += "[^/]*";
      else if (char === "?") source += "[^/]";
      else source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    // A directory glob like `apps/` or `apps` covers everything under it.
    return new RegExp(`^${source}(?:/.*)?$`);
  });
  return (path) => patterns.some((pattern) => pattern.test(path));
}

function parseProperties(text: string) {
  const props: Record<string, string> = {};
  for (const pair of text.split(",")) {
    const at = pair.indexOf("=");
    if (at > 0) props[pair.slice(0, at).trim()] = unescapeProperty(pair.slice(at + 1));
  }
  return props;
}

// The escapes GitHub's toolkit applies to command data and properties.
function unescapeData(text: string) {
  return text.replaceAll("%0D", "\r").replaceAll("%0A", "\n").replaceAll("%25", "%");
}

function unescapeProperty(text: string) {
  return unescapeData(text).replaceAll("%3A", ":").replaceAll("%2C", ",");
}

function relativePath(file: string, root: string) {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const path = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  return path.replace(/^\.\//, "");
}

// Tools repeat the location (`src/a.js:1:7: `) and sometimes the rule (`F401 `) at the start of
// the message, which the annotation already shows.
function stripPrefixes(message: string, path: string, title = "") {
  const name = path.split("/").pop() ?? path;
  const location = /^(\S+?):\d+(?::\d+)?: /.exec(message);
  let text =
    location && (location[1] === path || location[1].endsWith(name))
      ? message.slice(location[0].length)
      : message;
  const rule = /^([A-Z]+\d+) /.exec(text);
  if (rule && title.includes(rule[1])) text = text.slice(rule[0].length);
  return text;
}

function positive(value: string | undefined) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}
