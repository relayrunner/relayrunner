// What `relayrunner init` knows about a repo's workflows: which jobs can route through the relay,
// which already do, and which it leaves alone and why. Then the edit itself, which keeps the file
// as written (comments, quoting, order) apart from the lines it adds or changes.
//
// A routed job gets a relay job in front of it, the reusable workflow in relayrunner/actions,
// and runs wherever the relay answers:
//
//   relay-test:
//     uses: relayrunner/actions/.github/workflows/relay.yml@<RELAY_REF>
//     with:
//       machine: self-hosted
//       github: ubuntu-latest
//   test:
//     needs: relay-test
//     runs-on: ${{ needs.relay-test.outputs.runner }}

import { type HostedProviderId, hostedProviderOf } from "@relayrunner/providers";
import {
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  Scalar,
  YAMLMap,
  YAMLSeq,
  type Document,
} from "yaml";

/** The relay version `init` writes. Bump it with each relayrunner/actions release. */
export const RELAY_REF = "v1.0.0-beta.4";
export const RELAY_WORKFLOW = "relayrunner/actions/.github/workflows/relay.yml";

export type Verdict = "ready" | "routed" | "skipped";

export interface WorkflowJob {
  /** Path relative to the repo root, such as `.github/workflows/ci.yml`. */
  file: string;
  /** The job's id under `jobs:`. */
  job: string;
  verdict: Verdict;
  /** Why a job is skipped. */
  reason?: string;
  /** Things to check before running the job on a machine. The job can still be routed. */
  warnings: string[];
  /** For a ready job: where its old `runs-on` label goes in the relay. */
  provider?: "github" | HostedProviderId;
  label?: string;
  /** For a ready job: the relay's `machine` input. */
  machine?: string;
}

export interface WorkflowFile {
  file: string;
  source: string;
}

export interface AnalyzeOptions {
  /** The OS of the machine running `init`, for warnings about Linux-only steps. */
  hostOs?: "macos" | "linux";
}

const DEPLOY_SECRET = /\bsecrets\.(?!GITHUB_TOKEN\b)[A-Za-z_][A-Za-z0-9_]*/;
const LINUX_PACKAGE_MANAGER =
  /(^|[\s;&|(])(sudo\s+)?(apt-get|apt|yum|dnf|apk)\s+(install|update|add)\b/m;

export function analyzeWorkflows(files: WorkflowFile[], options: AnalyzeOptions = {}) {
  const jobs: WorkflowJob[] = [];
  const errors: { file: string; message: string }[] = [];
  for (const { file, source } of files) {
    const doc = parseDocument(source);
    if (doc.errors.length) {
      errors.push({ file, message: doc.errors[0]!.message.split("\n")[0]! });
      continue;
    }
    const workflow = doc.toJS() as Record<string, unknown> | null;
    if (!workflow || typeof workflow !== "object") continue;
    const all = workflow.jobs;
    if (!all || typeof all !== "object") continue;
    const relays = new Set(
      Object.entries(all as Record<string, Record<string, unknown>>)
        .filter(([, job]) => isRelayJob(job))
        .map(([id]) => id),
    );
    const reusableOnly = onlyWorkflowCall(workflow.on);
    for (const [id, raw] of Object.entries(all as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const job = raw as Record<string, unknown>;
      if (relays.has(id)) continue;
      jobs.push(judge(file, id, job, workflow, relays, reusableOnly, options));
    }
  }
  return { jobs, errors };
}

/** True when any job already runs where a relay sends it. */
export function isSetUp(jobs: WorkflowJob[]) {
  return jobs.some((job) => job.verdict === "routed");
}

function judge(
  file: string,
  id: string,
  job: Record<string, unknown>,
  workflow: Record<string, unknown>,
  relays: Set<string>,
  reusableOnly: boolean,
  options: AnalyzeOptions,
): WorkflowJob {
  const base = { file, job: id, warnings: [] as string[] };
  const skip = (reason: string): WorkflowJob => ({ ...base, verdict: "skipped", reason });

  if (typeof job.uses === "string") return skip("calls a reusable workflow");
  if (reusableOnly)
    return skip("part of a reusable workflow; it runs wherever the calling workflow sends it");
  const runsOn = job["runs-on"];
  if (runsOn === undefined) return skip("has no runs-on");
  if (typeof runsOn !== "string") return skip("runs-on is a list of labels or a runner group");
  if (runsOn.includes("${{")) {
    const relay = /^\$\{\{\s*needs\.([\w-]+)\.outputs\.runner\s*\}\}$/.exec(runsOn.trim())?.[1];
    if (relay && relays.has(relay)) return { ...base, verdict: "routed" };
    return skip("runs-on is an expression");
  }
  if (hasMatrix(job)) return skip("uses a matrix, and one relay can't serve every leg");
  const deploy = deploySignal(job, workflow);
  if (deploy) return skip(`looks like a deploy job (${deploy})`);

  const label = runsOn.trim();
  const lower = label.toLowerCase();
  let provider: "github" | HostedProviderId;
  let machine = "self-hosted";
  const hosted = hostedProviderOf(lower);
  if (/(^|-)windows-/.test(lower)) return skip("Windows jobs can't run on machines yet");
  if (hosted) {
    provider = hosted;
    // Such as depot-macos-latest: only a Mac can stand in for it.
    if (lower.includes("macos")) machine = "macOS";
  } else if (/^(ubuntu|macos)-/.test(lower)) {
    provider = "github";
    if (lower.startsWith("macos-")) machine = "macOS";
  } else if (lower === "relayrunner") return skip("already runs on RelayRunner");
  else if (lower === "self-hosted") return skip("already runs on a self-hosted runner");
  else return skip(`${label} isn't a GitHub-hosted or hosted provider label`);

  const warnings = jobWarnings(job, options);
  return { ...base, verdict: "ready", provider, label, machine, warnings };
}

function isRelayJob(job: Record<string, unknown> | null) {
  return typeof job?.uses === "string" && job.uses.split("@")[0] === RELAY_WORKFLOW;
}

function onlyWorkflowCall(on: unknown) {
  if (on === "workflow_call") return true;
  if (Array.isArray(on)) return on.length > 0 && on.every((event) => event === "workflow_call");
  if (on && typeof on === "object") {
    const events = Object.keys(on);
    return events.length > 0 && events.every((event) => event === "workflow_call");
  }
  return false;
}

function hasMatrix(job: Record<string, unknown>) {
  const strategy = job.strategy as Record<string, unknown> | undefined;
  return !!strategy && typeof strategy === "object" && strategy.matrix !== undefined;
}

function deploySignal(job: Record<string, unknown>, workflow: Record<string, unknown>) {
  if (job.environment !== undefined) return "environment";
  const permissions = job.permissions ?? workflow.permissions;
  if (permissions === "write-all") return "write-all permissions";
  if (
    permissions &&
    typeof permissions === "object" &&
    (permissions as Record<string, unknown>)["id-token"] === "write"
  )
    return "id-token: write";
  const secret = DEPLOY_SECRET.exec(JSON.stringify(job))?.[0];
  if (secret) return `uses ${secret}`;
  return null;
}

function jobWarnings(job: Record<string, unknown>, options: AnalyzeOptions) {
  const warnings: string[] = [];
  if (job.services !== undefined) warnings.push("uses services, which need Docker on the machine");
  if (job.container !== undefined)
    warnings.push("runs in a container, which needs Docker on the machine");
  const steps = Array.isArray(job.steps) ? (job.steps as Record<string, unknown>[]) : [];
  const providerActions = new Set<string>();
  let packages = false;
  for (const step of steps) {
    if (!step || typeof step !== "object") continue;
    if (typeof step.run === "string" && LINUX_PACKAGE_MANAGER.test(step.run)) packages = true;
    if (typeof step.uses === "string") {
      const action = step.uses.split("@")[0]!;
      if (action.startsWith("useblacksmith/")) providerActions.add(action);
      if (action.startsWith("docker://"))
        warnings.push("runs a Docker action, which needs Docker on the machine");
    }
  }
  if (packages && options.hostOs !== "linux")
    warnings.push(
      options.hostOs === "macos"
        ? "installs Linux packages (apt-get, yum or apk), which macOS doesn't have"
        : "installs Linux packages (apt-get, yum or apk)",
    );
  for (const action of providerActions)
    warnings.push(`uses ${action}, which is made for Blacksmith runners`);
  return warnings;
}

/**
 * Routes the given jobs of one workflow file through the relay. Returns the new file contents.
 * Each job must have come back `ready` from analyzeWorkflows for this same source.
 */
export function routeJobs(source: string, jobs: WorkflowJob[]) {
  const doc = parseDocument(source);
  const all = doc.get("jobs");
  if (!isMap(all)) throw new Error("This workflow has no jobs map.");
  for (const job of jobs) {
    if (job.verdict !== "ready" || !job.provider || !job.label)
      throw new Error(`${job.job} isn't ready to route.`);
    routeJob(doc, all, job);
  }
  return doc.toString({ lineWidth: 0, flowCollectionPadding: false });
}

function routeJob(doc: Document, all: YAMLMap, job: WorkflowJob) {
  const index = all.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === job.job);
  const pair = all.items[index];
  if (!pair || !isMap(pair.value)) throw new Error(`No job ${job.job} in this workflow.`);
  const node = pair.value;
  const relayId = freeId(all, `relay-${job.job}`);

  const relay = doc.createNode({
    uses: `${RELAY_WORKFLOW}@${RELAY_REF}`,
    with: { machine: job.machine ?? "self-hosted", [job.provider!]: job.label },
  }) as YAMLMap;
  const key = new Scalar(relayId);
  // Keep the blank line that separated this job from the one above it in front of the relay.
  const jobKey = pair.key as Scalar;
  key.spaceBefore = jobKey.spaceBefore;
  if (key.spaceBefore === undefined && index > 0) key.spaceBefore = true;
  key.commentBefore = jobKey.commentBefore;
  jobKey.commentBefore = undefined;
  jobKey.spaceBefore = true;
  all.items.splice(index, 0, doc.createPair(key, relay));

  // Point runs-on at the relay, keeping any comment on the old value.
  const runsOn = node.get("runs-on", true);
  const target = `\${{ needs.${relayId}.outputs.runner }}`;
  if (isScalar(runsOn)) {
    runsOn.value = target;
    runsOn.type = Scalar.PLAIN;
  } else node.set("runs-on", target);

  const needs = node.get("needs", true);
  if (needs === undefined) {
    const at = node.items.findIndex((item) => isScalar(item.key) && item.key.value === "runs-on");
    node.items.splice(Math.max(at, 0), 0, doc.createPair("needs", relayId));
  } else if (isSeq(needs)) {
    (needs as YAMLSeq).add(doc.createNode(relayId));
  } else if (isScalar(needs)) {
    const list = new YAMLSeq();
    list.flow = true;
    list.add(doc.createNode(needs.value));
    list.add(doc.createNode(relayId));
    node.set("needs", list);
  }
}

function freeId(all: YAMLMap, wanted: string) {
  const taken = new Set(
    all.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : "")),
  );
  if (!taken.has(wanted)) return wanted;
  for (let n = 2; ; n++) if (!taken.has(`${wanted}-${n}`)) return `${wanted}-${n}`;
}
