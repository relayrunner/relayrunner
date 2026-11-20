import { platformOf } from "@relayrunner/providers";
import { relayJobFor } from "@relayrunner/runner-order";
import type { RouterSetup, SetupJob, SetupWorkflow } from "./router-setup.ts";

/** A repo for the "Route a repo" sheet, with the workflows it has left to route. */
export type RepoToRoute = {
  id: number;
  name: string;
  /** Null when the App's copy of the repo hasn't arrived. */
  private: boolean | null;
  /** Workflows with no routed runs, busiest first. Empty for a repo with no recent runs. */
  workflows: SetupWorkflow[];
};

/** A job picked in the sheet, by the names GitHub shows. */
export type PickedJob = { workflow: string; job: string };

export type RepoProgress = {
  /** Repos with workflows left to route, busiest first. */
  left: RepoToRoute[];
  /** Repos the App sees with no runs in the window. `init` finds their jobs. */
  quiet: RepoToRoute[];
  /** Repos whose recent workflows all went through a relay. */
  routed: number;
  /** Repos with recent runs. */
  active: number;
  /** Each repo's workflows with a run through a relay, for spotting a repo's first routed run. */
  routedIn: Map<number, string[]>;
};

const ROUTE_SKILL_URL =
  "https://raw.githubusercontent.com/relayrunner/relayrunner/main/skills/relayrunner-route-jobs/SKILL.md";
const BRANCH = "relayrunner/route-jobs";
const PR_TITLE = "ci: route jobs through RelayRunner";
// Jobs that ship something start unchecked: `init` skips most of them, and they're the ones a
// person wants to look at before moving.
const SHIPS = /deploy|release|publish/i;

export function repoProgress(setup: RouterSetup | null): RepoProgress {
  const byRepo = new Map<number, SetupWorkflow[]>();
  for (const w of setup?.workflows ?? []) {
    const list = byRepo.get(w.repositoryId);
    if (list) list.push(w);
    else byRepo.set(w.repositoryId, [w]);
  }
  const visibility = new Map((setup?.repos ?? []).map((repo) => [repo.id, repo.private]));
  const left: RepoToRoute[] = [];
  const routedIn = new Map<number, string[]>();
  let routed = 0;
  for (const [id, workflows] of byRepo) {
    const through = workflows.filter((w) => w.routedRuns > 0).map((w) => w.workflow);
    if (through.length > 0) routedIn.set(id, through);
    const open = workflows.filter((w) => w.routedRuns === 0).sort((a, b) => b.runs - a.runs);
    const [busiest] = open;
    if (!busiest) {
      routed += 1;
      continue;
    }
    left.push({
      id,
      name: busiest.repository,
      private: visibility.get(id) ?? null,
      workflows: open,
    });
  }
  const quiet = (setup?.repos ?? [])
    .filter((repo) => !byRepo.has(repo.id))
    .map((repo) => ({
      id: repo.id,
      name: repo.fullName,
      private: repo.private,
      workflows: [],
    }));
  return {
    left: left.sort((a, b) => repoRuns(b) - repoRuns(a) || a.name.localeCompare(b.name)),
    quiet,
    routed,
    active: byRepo.size,
    routedIn,
  };
}

/**
 * The workflow whose first run through a relay shows the repo is routed, or null while it waits.
 * `watched` is the workflows routed from the sheet; null (a repo with no recent runs) takes any.
 */
export function firstRouted(
  progress: RepoProgress,
  repoId: number,
  watched: string[] | null,
): string | null {
  const through = progress.routedIn.get(repoId) ?? [];
  return through.find((w) => watched === null || watched.includes(w)) ?? null;
}

/** Its busiest workflow's runs in the window. */
export const repoRuns = (repo: RepoToRoute) => repo.workflows[0]?.runs ?? 0;

/** Jobs across its workflows left to route. */
export const repoJobCount = (repo: RepoToRoute) =>
  repo.workflows.reduce((sum, w) => sum + w.jobs.length, 0);

export const jobKey = (workflow: string, job: string) => `${workflow}\u0000${job}`;

/** Whether the sheet checks a job to start with. */
const startsPicked = (workflow: SetupWorkflow, job: SetupJob) =>
  !SHIPS.test(job.name) && !SHIPS.test(workflow.workflow);

/** The jobs the sheet starts with checked, by jobKey. */
export function defaultPicks(repo: RepoToRoute): Set<string> {
  return new Set(
    repo.workflows.flatMap((w) =>
      w.jobs.filter((job) => startsPicked(w, job)).map((job) => jobKey(w.workflow, job.name)),
    ),
  );
}

/**
 * Whether the sheet can save a size for the job before it routes: auto sizes are Linux x64 only,
 * init skips matrices and self-hosted jobs, and a job with a `name:` of its own has no relay name
 * to save it under.
 */
export function sizable(job: SetupJob) {
  const label = job.label?.toLowerCase();
  return (
    job.legs === 1 &&
    relayJobFor(job.name) !== null &&
    !!label &&
    label !== "self-hosted" &&
    platformOf(label) === "linux"
  );
}

/** The picked jobs in the order the sheet lists them. */
export function pickedJobs(repo: RepoToRoute, picks: Set<string>): PickedJob[] {
  return repo.workflows.flatMap((w) =>
    w.jobs
      .filter((job) => picks.has(jobKey(w.workflow, job.name)))
      .map((job) => ({ workflow: w.workflow, job: job.name })),
  );
}

// The steps after the agent has a checkout, shared by both prompts. Not `named`: every job init
// finds, for a repo with no recent runs to name jobs from. `auto`: init writes `auto` in place of
// each Linux x64 job's label, so its size is set on the Router page.
function routeSteps(named: boolean, auto: boolean): string[] {
  const flags = auto ? " --auto --json" : " --json";
  return [
    named
      ? "Run `npx relayrunner@latest init --plan --json`. Match the jobs listed by workflow and job name, and leave every other job alone. If init refuses the repo, say why and skip it."
      : "Run `npx relayrunner@latest init --plan --json`. If init refuses the repo, say why and skip it.",
    named
      ? `Run \`npx relayrunner@latest init --apply <those job ids>${flags}\`. If init skips one, don't hand-edit it; say why.`
      : `Run \`npx relayrunner@latest init --apply all${flags}\`. Don't hand-edit skipped jobs; say why each was skipped.`,
  ];
}

const numbered = (steps: string[]) => steps.map((step, i) => `${i + 1}. ${step}`).join("\n");
const jobLine = (job: PickedJob) => `${job.workflow} / ${job.job}`;

/** What to paste into a coding agent to route one repo's picked jobs and open a PR. */
export function routePrompt(repo: string, jobs: PickedJob[] | null, auto: boolean): string {
  const named = jobs !== null;
  const intro = named
    ? `Route these GitHub Actions jobs in ${repo} through RelayRunner:\n${jobs.map((job) => `- ${jobLine(job)}`).join("\n")}`
    : `Route ${repo}'s GitHub Actions jobs through RelayRunner.`;
  return [
    intro,
    numbered([
      `Work in a checkout of ${repo} (clone it with gh if needed), on a new branch named ${BRANCH}.`,
      ...routeSteps(named, auto),
      `Show me \`git diff\`. When I approve, commit, push, and open a PR titled "${PR_TITLE}".`,
    ]),
    `Details: ${ROUTE_SKILL_URL}`,
  ].join("\n\n");
}

/** One prompt for several repos: one PR each, the first checked before the rest. */
export function routeAllPrompt(
  repos: { name: string; jobs: PickedJob[] }[],
  auto: boolean,
): string {
  const list = repos
    .map((repo) => `- ${repo.name}: ${repo.jobs.map(jobLine).join(", ")}`)
    .join("\n");
  return [
    `Route GitHub Actions jobs through RelayRunner in these repos, one PR per repo:\n${list}`,
    `For each repo:\n${numbered([
      `Clone it with gh into a temp folder, on a new branch named ${BRANCH}.`,
      ...routeSteps(true, auto),
      `Commit, push, and open a PR titled "${PR_TITLE}". Don't merge anything.`,
    ])}`,
    "Show me the first repo's diff and wait for my OK before doing the rest. Finish with a table: repo, PR URL, jobs routed, and jobs skipped with why.",
    `Details: ${ROUTE_SKILL_URL}`,
  ].join("\n\n");
}
