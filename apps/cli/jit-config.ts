// Checks the JIT config in a `run` message before the CLI hands it to run.sh. The config tells the
// runner which server to take its job from, so a gateway that was compromised, or a --server the
// user was talked into, could otherwise point every connected machine at a server of its own and
// run anything there. GitHub's configs only name GitHub hosts, and the gateway names each runner
// after the machine and the route (machineRunnerName in @relayrunner/machine-protocol), so:
//
// - it holds exactly the three files GitHub's do. The runner writes each entry to disk under its
//   name, so any other name (`../../.zshrc`) would write outside the runner's directory;
// - every URL in it must be https on github.com, *.github.com or *.githubusercontent.com, and it
//   must name the server the runner takes its job from;
// - no object in it has two keys that differ only in case. The runner reads keys
//   case-insensitively and takes the last, so a duplicate could hide a value from this check;
// - the runner's name must end with the route id the `run` message carries.
//
// It can't tell a runner the gateway minted for this job from one a compromised gateway minted on
// a GitHub repo of its own: both are GitHub's. `target` says which repo, and the CLI prints it.
//
// The config is base64 JSON mapping the files the runner writes (.runner, .credentials,
// .credentials_rsaparams) to each file's base64 JSON.

import { isRunnerForRoute } from "@relayrunner/machine-protocol";

// When it checks out, `target` is what the runner is registered on: owner/repo for a repo runner,
// or the owner for an org runner, from the config's GitHubUrl. Null when the config doesn't say.
export type JitConfigCheck = { ok: true; target: string | null } | { ok: false; reason: string };

const GITHUB_HOSTS = [/^github\.com$/, /\.github\.com$/, /\.githubusercontent\.com$/];
const FILES = [".runner", ".credentials", ".credentials_rsaparams"];
// Fields the runner reads as URLs. Each must be one of GitHub's, whatever it looks like.
const URL_FIELDS = new Set(["serverurl", "serverurlv2", "githuburl", "authorizationurl"]);

export function checkJitConfig(encoded: string, routeId: string): JitConfigCheck {
  let files: Record<string, unknown>;
  try {
    files = decodeJson(encoded) as Record<string, unknown>;
    if (!files || typeof files !== "object") throw new Error();
  } catch {
    return { ok: false, reason: "it isn't a runner config" };
  }

  const names = Object.keys(files);
  if (names.length !== FILES.length || !FILES.every((name) => names.includes(name)))
    return { ok: false, reason: `it holds ${names.join(", ") || "nothing"}, not GitHub's files` };

  const decoded: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(files)) {
    if (typeof value !== "string") return { ok: false, reason: `${name} isn't a file` };
    try {
      decoded[name] = decodeJson(value);
    } catch {
      return { ok: false, reason: `${name} isn't JSON` };
    }
  }

  const runner = decoded[".runner"];
  if (!runner || typeof runner !== "object") return { ok: false, reason: "it has no .runner" };

  const duplicate = duplicateKey(decoded);
  if (duplicate) return { ok: false, reason: `it has ${duplicate} twice` };

  for (const url of urls(decoded)) {
    // WHATWG parsing reads `https:\\host` and `https:host` the way the runner does.
    const parsed = URL.canParse(url) ? new URL(url) : null;
    if (!parsed) return { ok: false, reason: `it names a URL that doesn't parse: ${url}` };
    if (parsed.protocol !== "https:" || !GITHUB_HOSTS.some((host) => host.test(parsed.hostname)))
      return { ok: false, reason: `it points the runner at ${parsed.origin}, not GitHub` };
  }

  const field = (key: string) => {
    const entry = Object.entries(runner).find(([name]) => name.toLowerCase() === key);
    return typeof entry?.[1] === "string" ? entry[1] : null;
  };
  if (!field("serverurl") && !field("serverurlv2"))
    return { ok: false, reason: "it doesn't say which GitHub server to use" };
  const runnerName = field("agentname");
  if (!runnerName || !isRunnerForRoute(runnerName, routeId))
    return {
      ok: false,
      reason: `its runner ${runnerName ?? "(no name)"} isn't for job ${routeId}`,
    };

  return { ok: true, target: target(field("githuburl")) };
}

// "https://github.com/acme/app" → "acme/app", "https://github.com/acme" → "acme".
function target(url: string | null) {
  if (!url || !URL.canParse(url)) return null;
  const path = new URL(url).pathname.split("/").filter(Boolean).slice(0, 2);
  return path.length ? path.join("/") : null;
}

// Every string in the decoded files that the runner might read as a URL: any value of a URL field,
// and any other value that starts with a scheme (`https:`, `http:`, `ftp:`…).
function urls(value: unknown, found: string[] = [], key = ""): string[] {
  if (typeof value === "string") {
    // An empty field (a ServerUrlV2 the runner doesn't use) points nowhere.
    const text = value.trim();
    if (text && (URL_FIELDS.has(key.toLowerCase()) || /^[a-z][a-z0-9+.-]*:/i.test(text)))
      found.push(text);
  } else if (Array.isArray(value)) {
    for (const item of value) urls(item, found);
  } else if (value && typeof value === "object") {
    for (const [name, item] of Object.entries(value)) urls(item, found, name);
  }
  return found;
}

// The first key that appears twice in one object, ignoring case, or null.
function duplicateKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = duplicateKey(item);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    const seen = new Set<string>();
    for (const [name, item] of Object.entries(value)) {
      if (seen.has(name.toLowerCase())) return name;
      seen.add(name.toLowerCase());
      const found = duplicateKey(item);
      if (found) return found;
    }
  }
  return null;
}

function decodeJson(base64: string): unknown {
  return JSON.parse(Buffer.from(base64, "base64").toString("utf8").replace(/^﻿/, ""));
}
