// `relayrunner init`: route a repo's GitHub Actions jobs through the relay, so they run on your
// machine when it's online and on their old runner otherwise. It only edits files in the
// checkout and never commits. Three ways to run it:
//
//   relayrunner init                   pick jobs, see the diff, confirm
//   relayrunner init --plan [--json]   list every job with its verdict; changes nothing
//   relayrunner init --apply <jobs>    route those jobs without prompting (`all` = every ready job)
//
// `--plan --json` and `--apply` are what an agent setting up RelayRunner drives.

import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { styleText } from "node:util";
import * as clack from "@clack/prompts";
import { defineCommand } from "citty";
import { isDeclined, rememberDeclined } from "./declined.ts";
import { unifiedDiff } from "./diff.ts";
import {
  findRepoRoot,
  originRepo,
  readWorkflowFiles,
  repoVisibility,
  type Visibility,
} from "./repo.ts";
import {
  analyzeWorkflows,
  isSetUp,
  RELAY_REF,
  routeJobs,
  type AnalyzeOptions,
  type WorkflowFile,
  type WorkflowJob,
} from "./workflows.ts";

export interface InitPlan {
  root: string;
  repo: string | null;
  visibility: Visibility;
  files: WorkflowFile[];
  jobs: WorkflowJob[];
  errors: { file: string; message: string }[];
}

export class InitError extends Error {}

export async function planInit(
  cwd = process.cwd(),
  options: AnalyzeOptions & { fetcher?: typeof fetch } = {},
): Promise<InitPlan> {
  const root = findRepoRoot(cwd);
  if (!root) throw new InitError("Not in a git checkout. Run `relayrunner init` inside a repo.");
  const repo = await originRepo(root);
  const visibility = repo ? await repoVisibility(repo, options.fetcher) : "unknown";
  const files = readWorkflowFiles(root);
  const { jobs, errors } = analyzeWorkflows(files, { hostOs: options.hostOs ?? hostOs() });
  return { root, repo, visibility, files, jobs, errors };
}

/** Picks jobs by `job`, `file:job` or `all`. Throws when a name is unknown, ambiguous or not ready. */
export function selectJobs(jobs: WorkflowJob[], names: string[]) {
  const ready = jobs.filter((job) => job.verdict === "ready");
  if (names.length === 1 && names[0] === "all") return ready;
  const picked = new Map<string, WorkflowJob>();
  for (const name of names) {
    const [file, id] = name.includes(":") ? name.split(/:(?=[^:]*$)/) : [undefined, name];
    const matches = jobs.filter(
      (job) => job.job === id && (!file || job.file === file || shortFile(job.file) === file),
    );
    if (!matches.length) throw new InitError(`No job named ${name}.`);
    if (matches.length > 1)
      throw new InitError(
        `${name} is in more than one workflow. Name it as ${matches.map((job) => `${job.file}:${job.job}`).join(" or ")}.`,
      );
    const job = matches[0]!;
    if (job.verdict === "routed") throw new InitError(`${name} is already routed.`);
    if (job.verdict === "skipped") throw new InitError(`${name} can't be routed: ${job.reason}.`);
    picked.set(`${job.file}:${job.job}`, job);
  }
  return [...picked.values()];
}

/** The new contents of each workflow file the chosen jobs live in. */
export function changesFor(plan: InitPlan, chosen: WorkflowJob[]) {
  const byFile = new Map<string, WorkflowJob[]>();
  for (const job of chosen) byFile.set(job.file, [...(byFile.get(job.file) ?? []), job]);
  return [...byFile].map(([file, jobs]) => {
    const before = plan.files.find((entry) => entry.file === file)!.source;
    return { file, jobs, before, after: routeJobs(before, jobs) };
  });
}

export function writeChanges(root: string, changes: ReturnType<typeof changesFor>) {
  for (const change of changes) writeFileSync(join(root, change.file), change.after);
}

function hostOs(): AnalyzeOptions["hostOs"] {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return undefined;
}

const PUBLIC_REPO =
  "This repo is public, and machines never take jobs from public repos. There's nothing for init to set up here.";

export const initCommand = defineCommand({
  meta: {
    name: "init",
    description:
      "Route this repo's GitHub Actions jobs through RelayRunner, so they run on your machine when it's online. Edits workflow files; never commits.",
  },
  args: {
    plan: {
      type: "boolean",
      description: "List every job and whether it can be routed. Changes nothing.",
    },
    apply: {
      type: "string",
      description:
        "Route these jobs without prompting: comma-separated ids or file:job, or `all` for every ready job",
    },
    json: { type: "boolean", description: "Print the result as JSON (with --plan or --apply)" },
  },
  async run({ args }) {
    try {
      const plan = await planInit();
      if (args.apply !== undefined) return apply(plan, args.apply, !!args.json);
      if (args.plan || args.json) return printPlan(plan, !!args.json);
      if (!process.stdin.isTTY) {
        printPlan(plan, false);
        console.log("\nRun `relayrunner init --apply <jobs>` to route jobs without prompts.");
        return;
      }
      await interactive(plan);
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      if (args.json) console.log(JSON.stringify({ error: error.message }, null, 2));
      else console.error(error.message);
      process.exitCode = 1;
    }
  },
});

function planJson(plan: InitPlan) {
  return {
    repo: plan.repo,
    visibility: plan.visibility,
    relay: RELAY_REF,
    setUp: isSetUp(plan.jobs),
    ...(plan.visibility === "public" ? { refused: "public_repo" } : {}),
    jobs: plan.jobs,
    errors: plan.errors,
  };
}

function printPlan(plan: InitPlan, json: boolean) {
  if (json) return console.log(JSON.stringify(planJson(plan), null, 2));
  console.log(describeRepo(plan));
  if (plan.visibility === "public") return console.log(PUBLIC_REPO);
  if (!plan.files.length) return console.log("No workflows in .github/workflows.");
  for (const [title, verdict] of [
    ["Ready to route", "ready"],
    ["Already routed", "routed"],
    ["Skipped", "skipped"],
  ] as const) {
    const jobs = plan.jobs.filter((job) => job.verdict === verdict);
    if (!jobs.length) continue;
    console.log(`\n${title}`);
    for (const job of jobs) console.log(`  ${jobLine(job)}`);
  }
  for (const error of plan.errors) console.log(`\nCouldn't read ${error.file}: ${error.message}`);
}

function apply(plan: InitPlan, list: string, json: boolean) {
  if (plan.visibility === "public") throw new InitError(PUBLIC_REPO);
  const names = list
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (!names.length) throw new InitError("Name the jobs to route, or `all`.");
  const chosen = selectJobs(plan.jobs, names);
  if (!chosen.length) throw new InitError("No jobs are ready to route.");
  const changes = changesFor(plan, chosen);
  writeChanges(plan.root, changes);
  const routed = chosen.map(({ file, job, warnings }) => ({ file, job, warnings }));
  if (json) return console.log(JSON.stringify({ relay: RELAY_REF, routed }, null, 2));
  for (const change of changes)
    console.log(`Updated ${change.file} (${change.jobs.map((job) => job.job).join(", ")})`);
  console.log("Commit and push to start routing.");
}

async function interactive(plan: InitPlan) {
  clack.intro("RelayRunner init");
  clack.log.info(describeRepo(plan));
  if (plan.visibility === "public") return clack.outro(PUBLIC_REPO);
  if (plan.visibility === "unknown")
    clack.log.warn(
      "Couldn't check whether this repo is public. Machines only take jobs from private repos.",
    );
  for (const error of plan.errors) clack.log.warn(`Couldn't read ${error.file}: ${error.message}`);
  if (!plan.files.length) return clack.outro("No workflows in .github/workflows.");
  await chooseAndWrite(plan, (message) => clack.outro(message));
}

/** Lists the jobs, lets the user pick, shows the diff and writes it. `finish` gets the last line. */
async function chooseAndWrite(plan: InitPlan, finish: (message: string) => void) {
  const routed = plan.jobs.filter((job) => job.verdict === "routed");
  const skipped = plan.jobs.filter((job) => job.verdict === "skipped");
  const ready = plan.jobs.filter((job) => job.verdict === "ready");
  if (routed.length) clack.note(routed.map(jobLine).join("\n"), "Already routed");
  if (skipped.length) clack.note(skipped.map(jobLine).join("\n"), "Skipped");
  if (!ready.length) return finish("No other jobs to route.");

  const picked = await clack.multiselect({
    message: "Route these jobs through RelayRunner?",
    options: ready.map((job) => ({
      value: job,
      label: `${shortFile(job.file)} › ${job.job}`,
      hint: [`${job.label} when your machine is offline`, ...job.warnings].join("; "),
    })),
    initialValues: ready,
    required: false,
  });
  if (clack.isCancel(picked) || !picked.length) return finish("Nothing changed.");

  const changes = changesFor(plan, picked);
  for (const change of changes)
    console.log(`${colorDiff(unifiedDiff(change.before, change.after, change.file))}\n`);
  const ok = await clack.confirm({
    message: `Write ${changes.length === 1 ? "this change" : `these ${changes.length} changes`}?`,
  });
  if (clack.isCancel(ok) || !ok) return finish("Nothing changed.");

  writeChanges(plan.root, changes);
  const warned = picked.filter((job) => job.warnings.length);
  if (warned.length)
    clack.note(
      warned.map((job) => `${job.job}: ${job.warnings.join("; ")}`).join("\n"),
      "Check before it runs on your machine",
    );
  finish(
    `Updated ${changes.map((change) => change.file).join(", ")}. Commit and push to start routing.`,
  );
}

/**
 * Whether `connect` should offer to set up this checkout: it's not public, nothing in it is routed
 * yet, and at least one job could be.
 */
export function shouldOfferSetup(plan: InitPlan) {
  return (
    plan.visibility !== "public" &&
    !isSetUp(plan.jobs) &&
    plan.jobs.some((job) => job.verdict === "ready")
  );
}

/**
 * Run by `connect` before it goes online. Inside a repo that could use RelayRunner but doesn't
 * yet, asks once whether to set it up (default no) and runs the same picker as `init`. A "no" is
 * remembered for that repo, so later runs don't ask again; `relayrunner init` still works. Never
 * throws: setup is a convenience, and `connect` goes online either way.
 */
export async function offerSetup(cwd = process.cwd()) {
  try {
    const plan = await planInit(cwd).catch((error: unknown) => {
      if (error instanceof InitError) return null;
      throw error;
    });
    if (!plan || !shouldOfferSetup(plan)) return;
    const key = plan.repo ?? plan.root;
    if (isDeclined(key)) return;
    const answer = await clack.confirm({
      message: `Set up ${plan.repo ?? basename(plan.root)} to run its CI on this machine?`,
      initialValue: false,
    });
    if (clack.isCancel(answer)) return;
    if (!answer) {
      rememberDeclined(key);
      clack.log.info("Not now. Run `relayrunner init` in this repo any time to set it up.");
      return;
    }
    await chooseAndWrite(plan, (message) => clack.log.success(message));
  } catch (error) {
    clack.log.warn(
      `Couldn't check this repo's workflows: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function describeRepo(plan: InitPlan) {
  if (!plan.repo) return `${plan.root} (no GitHub remote named origin)`;
  return plan.visibility === "unknown" ? plan.repo : `${plan.repo} (${plan.visibility})`;
}

function jobLine(job: WorkflowJob) {
  const name = `${shortFile(job.file)} › ${job.job}`;
  if (job.verdict === "skipped") return `${name}: ${job.reason}`;
  if (job.verdict === "routed") return name;
  const notes = [`falls back to ${job.label}`, ...job.warnings];
  return `${name}: ${notes.join("; ")}`;
}

function shortFile(file: string) {
  return file.replace(/^\.github\/workflows\//, "");
}

function colorDiff(diff: string) {
  return diff
    .split("\n")
    .map((line) =>
      line.startsWith("+") && !line.startsWith("+++")
        ? styleText("green", line)
        : line.startsWith("-") && !line.startsWith("---")
          ? styleText("red", line)
          : styleText("dim", line),
    )
    .join("\n");
}
