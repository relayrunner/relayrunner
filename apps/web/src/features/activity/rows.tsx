// One row per kind of Activity event: jobs, checks, retries, routing failures and settings changes.
import { Link } from "@tanstack/react-router";
import { RUNNER_LABELS, stepText } from "@relayrunner/runner-order";
import {
  Archive,
  Ban,
  ChevronRight,
  Cpu,
  ListOrdered,
  CircleCheck,
  CircleMinus,
  Laptop,
  Lock,
  Pause,
  Play,
  Plug,
  Plus,
  RotateCw,
  ScrollText,
  Sparkles,
  Unplug,
  UserCheck,
  UserMinus,
  Zap,
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { GithubUser, shortSha } from "@/components/commit";
import { PublicRepoMark } from "@/components/public-repo";
import { GithubIcon } from "@/components/provider-logos";
import { RunLink } from "@/components/run-sheet";
import { RunnerLink } from "@/components/runner-link";
import { WorkflowLink } from "@/components/workflow-link";
import { StatusIcon } from "@/components/status-icon";
import { WalkLines } from "@/components/walk-lines";
import {
  duration,
  timeAgo,
  type ActivityItem,
  type ActivityJob,
  type ActivityRunner,
  type ActivityStarter,
  type ActivityStarters,
} from "@/lib/activity";
import { minutes, money, type FreeCheckSavings } from "@/lib/usage";
import { failureText, jobNames, walkSummary } from "@/lib/route-walk";
import { formatDateTime } from "@/lib/time-zone";

const usd = (amount: number) =>
  amount.toLocaleString("en-US", { style: "currency", currency: "USD" });

const DISCONNECT_REASONS = {
  closed: "its CLI stopped",
  timeout: "it stopped responding",
  revoked: "it was revoked",
  error: "of a protocol error",
} as const;

// What a non-job event says, in a sentence after the machine's name.
function sentence(item: ActivityItem) {
  switch (item.type) {
    case "machine.enrolled": {
      const platform = [item.data.os, item.data.arch].filter(Boolean).join(" ");
      const verb = item.data.source === "github" ? "was added from GitHub" : "enrolled";
      return `${verb}${platform ? ` (${platform})` : ""}`;
    }
    case "machine.connected":
      return "connected";
    case "machine.disconnected":
      return `disconnected because ${DISCONNECT_REASONS[item.data.reason]}`;
    case "machine.paused":
      return item.data.via === "cli" ? "was paused from its CLI" : "was paused";
    case "machine.resumed":
      return item.data.via === "cli" ? "was resumed from its CLI" : "was resumed";
    case "machine.sharing_changed":
      return item.data.sharing === "only_me"
        ? "was set to run only its owner's jobs"
        : "was shared with the workspace";
    case "machine.workspace_added":
      return "was added to this workspace";
    case "machine.workspace_removed":
      return "was taken out of this workspace";
    case "machine.revoked":
      return item.data.source === "github" ? "was removed from RelayRunner" : "was revoked";
    case "job.routed":
      return "routed a job";
    case "job.unroutable":
      return "couldn't route a job";
    case "job.retried":
      return "retried a job";
    case "check.completed":
      return item.data.conclusion === "success" ? "passed" : "failed";
    case "minutes.overage":
      return "went past its included GitHub Actions minutes";
    case "member.joined":
    case "member.removed":
      return memberSentence(item);
  }
}

// Member events lead with who: "Ada joined as an admin", "Zach left the workspace".
function memberSentence(item: ActivityItem) {
  switch (item.type) {
    case "member.joined":
      return `joined as ${article(item.data.role)}`;
    case "member.removed":
      return item.data.left ? "left the workspace" : `removed ${item.data.memberName}`;
    default:
      return "";
  }
}

// Settings events lead with who: "Ada set the default size for auto jobs to 4 vCPU".
function settingsSentence(item: ActivityItem) {
  switch (item.type) {
    case "settings.runner_order": {
      const { repository, steps } = item.data;
      const order = repository ? `${repository}'s runner order` : "the runner order";
      return `set ${order} to ${steps.map(stepText).join(", then ")}`;
    }
    case "settings.runner_order_removed":
      return `put ${item.data.repository} back on the workspace's runner order`;
    case "settings.auto_size":
      return `set the default size for auto jobs to ${item.data.size} vCPU`;
    case "settings.job_size": {
      const { job, workflow, repository, size, first } = item.data;
      const name = `${repository} › ${workflow ?? job}`;
      if (size === null && first === null) return `put ${name} back on the defaults`;
      const parts = [
        size === null ? "the default size" : `${size} vCPU`,
        ...(first ? [`trying ${RUNNER_LABELS[first]} first`] : []),
      ];
      return `set ${name} to ${parts.join(", ")}`;
    }
    case "settings.retries":
      return item.data.enabled
        ? `turned on automatic retries, up to ${item.data.max} per run`
        : "turned off automatic retries";
    case "settings.ai":
      return item.data.enabled ? "turned on AI features" : "turned off AI features";
    case "settings.job_logs":
      return item.data.logs === "off"
        ? "stopped sending job logs"
        : `started sending ${item.data.logs === "all" ? "every job's log" : "failed jobs' logs"}`;
    case "settings.log_bucket":
      return item.data.logs === "off"
        ? "stopped archiving job logs to a bucket"
        : `started archiving ${item.data.logs === "all" ? "every job's log" : "failed jobs' logs"} to a bucket`;
    case "settings.log_destination": {
      const { target, change, name } = item.data;
      if (target === "bucket")
        return change === "place"
          ? `moved the log archive to the ${name} bucket`
          : "changed the log archive's access key";
      return change === "place"
        ? `pointed telemetry at ${name}`
        : "changed the telemetry endpoint's headers";
    }
    default:
      return "";
  }
}

// " through Claude" when a person made the change with an agent.
function throughAgent(item: ActivityItem) {
  const { agent } = item.data as { agent?: string };
  return agent ? ` through ${agent}` : "";
}

function article(role: string) {
  return /^[aeiou]/i.test(role) ? `an ${role}` : `a ${role}`;
}

const EVENT_ICONS = {
  "machine.enrolled": Plus,
  "machine.connected": Plug,
  "machine.disconnected": Unplug,
  "machine.paused": Pause,
  "machine.resumed": Play,
  "machine.sharing_changed": Lock,
  "machine.workspace_added": Plus,
  "machine.workspace_removed": CircleMinus,
  "machine.revoked": Ban,
  "member.removed": UserMinus,
  "job.routed": Laptop,
  "job.unroutable": Ban,
  "job.retried": RotateCw,
  "check.completed": CircleCheck,
  "member.joined": UserCheck,
  "minutes.overage": TriangleAlert,
  "settings.runner_order": ListOrdered,
  "settings.runner_order_removed": ListOrdered,
  "settings.auto_size": Cpu,
  "settings.job_size": Cpu,
  "settings.retries": RotateCw,
  "settings.ai": Sparkles,
  "settings.job_logs": ScrollText,
  "settings.log_bucket": Archive,
  "settings.log_destination": Archive,
} as const;

const ICON = "size-3.5 shrink-0";

// The log's columns on wider screens: icon, what happened, runner, repo, who started it, and the
// time. Every row is a subgrid of these, so the runner, repo and person line up down the page and
// the eye can scan a column instead of reading each sentence. Phones get the icon, the sentence
// and the time, with the runner and repo on a second line.
export const LOG_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-x-3 sm:grid-cols-[auto_minmax(0,1fr)_fit-content(10rem)_fit-content(15rem)_fit-content(9rem)_auto]";

/** A job's or check's runner, repo and who started it, each in its own column. */
type Cells = { runner?: ReactNode; repo?: ReactNode; who?: ReactNode };

// Every Activity row: an icon, one line of text that ends in "…" when it doesn't fit (hover shows
// all of it), the row's `cells`, and the time pinned on the right. A row without cells (a machine
// or member event) lets its sentence run across the cells' columns. A row with `toggle` gets a
// chevron before the time that shows `detail` under the line, indented to the text.
function Row({
  icon,
  at,
  now,
  toggle,
  detail,
  why = "why it ran here",
  cells,
  children,
}: {
  icon: ReactNode;
  at: string;
  now: number;
  toggle?: Toggle;
  // What the chevron shows, for its label: "Show why it ran here".
  why?: string;
  detail?: ReactNode;
  cells?: Cells;
  children: ReactNode;
}) {
  const cell = "hidden min-w-0 items-center truncate text-xs text-muted-foreground sm:flex";
  const meta = cells && [cells.runner, cells.repo].filter(Boolean);
  return (
    <li className="col-span-full grid grid-cols-subgrid items-center border-b border-border/60 py-2 text-sm last:border-b-0">
      <span className="flex w-4 justify-center">{icon}</span>
      <div className={cells ? "min-w-0" : "min-w-0 sm:col-span-4"}>
        <p
          className="truncate"
          ref={(el) => {
            if (el) el.title = el.textContent ?? "";
          }}
        >
          {children}
        </p>
        {meta && meta.length > 0 && (
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground sm:hidden">
            {meta.map((node, index) => (
              <span key={index} className="flex min-w-0 items-center gap-1.5 overflow-hidden">
                {index > 0 && <span aria-hidden>·</span>}
                {node}
              </span>
            ))}
          </p>
        )}
      </div>
      {cells && (
        <>
          <span className={cell}>{cells.runner}</span>
          <span className={cell}>{cells.repo}</span>
          <span className={cell}>{cells.who}</span>
        </>
      )}
      <span className="flex shrink-0 items-center justify-end gap-1">
        {toggle && (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.open}
            aria-label={toggle.open ? `Hide ${why}` : `Show ${why}`}
            title={toggle.open ? "Hide why" : "Show why"}
            className="-my-1 cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={`size-3.5 transition-transform ${toggle.open ? "rotate-90" : ""}`}
            />
          </button>
        )}
        <span
          className="min-w-[4.5ch] text-right text-xs text-muted-foreground tabular-nums"
          title={formatDateTime(at)}
        >
          {timeAgo(at, now)}
        </span>
      </span>
      {toggle?.open && (
        <div className="col-span-full min-w-0 pl-7 sm:col-[2/-1] sm:pl-0">{detail}</div>
      )}
    </li>
  );
}

// A row's workflow, quieter than the job.
const QUIET = "text-muted-foreground hover:text-foreground";

// A repo with GitHub's mark, by its name without the owner (the filter and hover show it all), and
// the branch after it: "relayrunner · main". The name opens the repo on GitHub.
function RepoCell({ repository, branch }: { repository: string; branch?: string | null }) {
  const name = repository.slice(repository.indexOf("/") + 1);
  return (
    <span
      className="flex min-w-0 items-center gap-1.5"
      title={branch ? `${repository} · ${branch}` : repository}
    >
      <GithubIcon className="size-3.5 text-muted-foreground" />
      <a
        href={`https://github.com/${repository}`}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 text-foreground/75 hover:text-foreground hover:underline"
      >
        {name}
      </a>
      <PublicRepoMark repository={repository} className="ml-0" />
      {branch && <span className="truncate">· {branch}</span>}
    </span>
  );
}

// Who started the run, with their GitHub picture, the way the Runners page shows a machine's
// owner. A re-run shows who re-ran it; the hover names both.
function StarterCell({ starters }: { starters: ActivityStarters }) {
  const { startedBy, rerunBy } = starters;
  const who = rerunBy ?? startedBy;
  if (!who) return null;
  const label = (starter: ActivityStarter) => starter.member?.name ?? starter.login;
  const title = [
    startedBy && `Started by ${label(startedBy)}`,
    rerunBy && `re-run by ${label(rerunBy)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={title}>
      <GithubUser
        login={who.login}
        name={label(who)}
        nameClassName={who.member ? undefined : "font-mono"}
      />
      {rerunBy && <RotateCw aria-label="Re-run" className="size-3 shrink-0" />}
    </span>
  );
}

const REASON_TONES = {
  fallback: "text-run decoration-run/50",
  info: "text-foreground/75 decoration-muted-foreground/60",
  failure: "text-destructive decoration-destructive/50",
} as const;

type Toggle = { open: boolean; onToggle: () => void };

// The short reason after a job's runner. With `toggle`, clicking it also shows the walk (the row's
// chevron is the keyboard stop).
function Reason({
  text,
  tone,
  toggle,
}: {
  text: string;
  tone: keyof typeof REASON_TONES;
  toggle?: Toggle;
}) {
  const style = `text-xs underline decoration-dotted underline-offset-2 ${REASON_TONES[tone]}`;
  if (!toggle) return <span className={style}>{text}</span>;
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={toggle.onToggle}
      className={`${style} cursor-pointer hover:decoration-solid`}
    >
      {text}
    </button>
  );
}

// A one-line row for anything that isn't a job: "Atticus's MacBook connected · 2m ago".
export function EventRow({ item, now }: { item: ActivityItem; now: number }) {
  const Icon = EVENT_ICONS[item.type];
  const online = item.type === "machine.connected";
  if (item.type === "minutes.overage")
    return (
      <Row
        icon={<TriangleAlert aria-hidden className={`${ICON} text-destructive`} />}
        at={item.occurredAt}
        now={now}
      >
        <span className="font-medium">{item.data.account}</span>{" "}
        <span className="text-muted-foreground">
          went past its included GitHub Actions minutes. GitHub has billed{" "}
          {usd(item.data.netAmount)} in overage this month.
        </span>
      </Row>
    );
  if (item.type.startsWith("settings.")) {
    return (
      <Row
        icon={<Icon aria-hidden className={`${ICON} text-muted-foreground`} />}
        at={item.occurredAt}
        now={now}
      >
        <span className="font-medium">{item.actor?.name ?? "Someone"}</span>{" "}
        <span className="text-muted-foreground">
          {settingsSentence(item)}
          {throughAgent(item)}
        </span>
      </Row>
    );
  }
  if (item.type.startsWith("member.")) {
    const who =
      item.type === "member.joined"
        ? item.data.name
        : item.type === "member.removed" && item.data.left
          ? (item.actor?.name ?? item.data.memberName)
          : item.actor?.name;
    return (
      <Row
        icon={
          <Icon
            aria-hidden
            className={
              item.type === "member.joined" ? `${ICON} text-go` : `${ICON} text-muted-foreground`
            }
          />
        }
        at={item.occurredAt}
        now={now}
      >
        <span className="font-medium">{who ?? "Someone"}</span>{" "}
        <span className="text-muted-foreground">{memberSentence(item)}</span>
      </Row>
    );
  }
  return (
    <Row
      icon={
        <Icon
          aria-hidden
          className={online ? `${ICON} text-go` : `${ICON} text-muted-foreground`}
        />
      }
      at={item.occurredAt}
      now={now}
    >
      {item.machine?.id ? (
        <RunnerLink
          runner={{ key: `machine:${item.machine.id}`, label: item.machine.name }}
          mark={false}
          className="font-medium"
        />
      ) : (
        <span className="font-medium">{item.machine?.name ?? "A machine"}</span>
      )}{" "}
      <span className="text-muted-foreground">{sentence(item)}</span>
      {item.actor && (
        <span className="text-muted-foreground">
          {" "}
          by {item.actor.name}
          {throughAgent(item)}
        </span>
      )}
    </Row>
  );
}

// What happened to the job: "passed", "waiting for a machine", ...
function jobVerb(job: ActivityJob) {
  if (job.status === "in_progress") return "running";
  if (job.status !== "completed")
    return job.runner.type === "machine" ? "waiting for its machine" : "queued";
  if (job.conclusion === "success") return "passed";
  if (isFailed(job.conclusion)) return "failed";
  return job.conclusion?.replace("_", " ") ?? "finished";
}

const isFailed = (conclusion: string | null) =>
  conclusion === "failure" || conclusion === "timed_out";

// A row naming the job the way GitHub does ("workflow / job"), then what happened and how long it
// took: "CI / test passed · 1m 30s", with its runner, repo and who started it in their columns. The
// job name opens the job in History's run panel, the workflow name opens the workflow's panel.
export function JobRow({ job, now }: { job: ActivityJob; now: number }) {
  const [open, setOpen] = useState(false);
  const took = duration(job, now);
  const { runner, walk } = job;
  // GitHub never sent the job anywhere: a job it needed failed, so its runs-on was never worked
  // out. Usually folded into its relay's "couldn't run" entry; this row is for runs without one.
  const unrouted = runner.type === "github" && !runner.label;
  const runnerName =
    runner.type === "machine" ? (runner.name ?? "a self-hosted machine") : runner.label;
  const summary = walk ? walkSummary(walk) : null;
  const toggle = summary ? { open, onToggle: () => setOpen(!open) } : undefined;
  return (
    <Row
      icon={<StatusIcon status={job.status} conclusion={job.conclusion} className={ICON} />}
      at={job.createdAt}
      now={now}
      toggle={toggle}
      detail={walk && <WalkLines walk={walk} runner={runnerName} />}
      cells={{
        runner: unrouted ? (
          <Reason text="not routed" tone="info" />
        ) : (
          <span
            className="min-w-0 truncate text-foreground/75"
            title={job.runnerName ? `Ran on ${job.runnerName}` : "Not picked up yet"}
          >
            <RunnerLink
              runner={{ key: runnerKey(runner), label: runnerName }}
              markClassName="mr-1.5 inline-flex size-4 rounded-[4px] align-[-0.25em]"
            />
          </span>
        ),
        repo: <RepoCell repository={job.repository} branch={job.branch} />,
        who: <StarterCell starters={job.starters} />,
      }}
    >
      <WorkflowLink
        repository={job.repository}
        workflow={job.workflow}
        fallback="Workflow"
        className={QUIET}
      />
      <span className="text-muted-foreground"> / </span>
      <RunLink run={job} job={job.id} className="font-medium hover:underline">
        {job.name}
      </RunLink>{" "}
      <span className={isFailed(job.conclusion) ? "text-destructive" : "text-muted-foreground"}>
        {jobVerb(job)}
      </span>
      {took && <span className="text-muted-foreground tabular-nums">{` · ${took}`}</span>}
      {summary && (
        <>
          {" "}
          <Reason text={summary.text} tone={summary.tone} toggle={toggle} />
        </>
      )}
    </Row>
  );
}

// The last 30 days of optimized checks, beside the page title: "Optimized checks saved 200 minutes
// in 30 days". Opens Usage.
export function SavingsLink({ savings }: { savings: FreeCheckSavings }) {
  return (
    <Link
      to="/usage"
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      title={`One billed minute per check or lint run${savings.savedCost > 0 ? `, ${money(savings.savedCost)}` : ""}. See usage.`}
    >
      <Zap aria-hidden className="size-3.5 text-go" />
      <span>
        Optimized checks saved {minutes(savings.checks)}{" "}
        {savings.checks === 1 ? "minute" : "minutes"} in {savings.days} days
      </span>
    </Link>
  );
}

// A check that ran with no Actions runner: "PR title passed on #12 · no runner · acme/app". The
// check opens its run on GitHub, the number opens the pull request. A lint run from a native job
// has no pull request, so it names its commit: "Lint failed on 4f9c2e1".
export function CheckRow({
  item,
  now,
}: {
  item: Extract<ActivityItem, { type: "check.completed" }>;
  now: number;
}) {
  const { data } = item;
  const on =
    data.pullRequest === null
      ? {
          path: `commit/${data.headSha}/checks`,
          title: "Open the commit's checks on GitHub",
          label: shortSha(data.headSha),
          className: "font-mono",
        }
      : {
          path: `pull/${data.pullRequest}`,
          title: "Open the pull request on GitHub",
          label: `#${data.pullRequest}`,
          className: "",
        };
  return (
    <Row
      icon={<StatusIcon status="completed" conclusion={data.conclusion} className={ICON} />}
      at={item.occurredAt}
      now={now}
      cells={{
        runner: (
          <span
            className="flex items-center gap-1.5 text-foreground/75"
            title="Ran with no Actions runner, so GitHub billed no Actions minute"
          >
            <Zap aria-hidden className="size-3.5 shrink-0 text-go" />
            No runner
          </span>
        ),
        repo: <RepoCell repository={data.repository} />,
      }}
    >
      {data.url ? (
        <a
          href={data.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium hover:underline"
          title="Open the check on GitHub"
        >
          {data.check}
        </a>
      ) : (
        <span className="font-medium">{data.check}</span>
      )}{" "}
      <span
        className={data.conclusion === "success" ? "text-muted-foreground" : "text-destructive"}
      >
        {sentence(item)}
      </span>{" "}
      <span className="text-muted-foreground">on</span>{" "}
      <a
        href={`https://github.com/${data.repository}/${on.path}`}
        target="_blank"
        rel="noreferrer"
        className={`font-medium hover:underline ${on.className}`}
        title={on.title}
      >
        {on.label}
      </a>
    </Row>
  );
}

// A run whose relay failed fast because nothing in the runner order could take it, told as the jobs
// that couldn't run: "RelayRunner dev / build and test couldn't run no idle machine with macOS ·
// repo". The relay itself isn't named: it's how routing works, not a job anyone thinks about. Until
// GitHub reports the jobs skipped, it's the run: "RelayRunner dev couldn't run".
export function UnroutableRow({
  item,
  now,
}: {
  item: Extract<ActivityItem, { type: "job.unroutable" }>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const { data } = item;
  const toggle = data.walk ? { open, onToggle: () => setOpen(!open) } : undefined;
  const names = jobNames(item.jobsNotRun ?? []);
  return (
    <Row
      icon={<Ban aria-label="Couldn't run" className={`${ICON} text-destructive`} />}
      at={item.occurredAt}
      now={now}
      toggle={toggle}
      why="why it couldn't run"
      detail={data.walk && <WalkLines walk={data.walk} runner={null} />}
      cells={{
        repo: <RepoCell repository={data.repository} />,
        who: item.starters && <StarterCell starters={item.starters} />,
      }}
    >
      <WorkflowLink
        repository={data.repository}
        workflow={data.workflow}
        fallback="Workflow"
        className={QUIET}
      />
      {names && (
        <>
          <span className="text-muted-foreground"> / </span>
          <span className="font-medium">{names}</span>
        </>
      )}{" "}
      <span className="text-destructive">couldn't run</span>{" "}
      <Reason text={failureText(data.reason)} tone="failure" toggle={toggle} />
    </Row>
  );
}

const RETRY_REASONS = {
  runner_start: () => "its runner never started it",
  machine_lost: (on: string | null) => `${on ?? "its machine"} went offline`,
  runner_lost: () => "GitHub lost touch with its runner",
  flaky: () => "it looked flaky",
  provider_missed: (on: string | null) => `${on ?? "its runner"} didn't pick it up`,
} as const;

const RETRY_RUNNERS = { any: "", same: " on the same runner", other: " on a different runner" };

// A job the Router re-ran because its runner failed it: "RelayRunner dev / test was retried
// because atticus-mbp went offline · repo".
export function RetryRow({
  item,
  now,
}: {
  item: Extract<ActivityItem, { type: "job.retried" }>;
  now: number;
}) {
  const { data } = item;
  return (
    <Row
      icon={<RotateCw aria-hidden className={`${ICON} text-muted-foreground`} />}
      at={item.occurredAt}
      now={now}
      cells={{ repo: <RepoCell repository={data.repository} /> }}
    >
      <WorkflowLink
        repository={data.repository}
        workflow={data.workflow}
        fallback="Workflow"
        className={QUIET}
      />
      <span className="text-muted-foreground"> / </span>
      <span className="font-medium">{data.job}</span>{" "}
      <span className="text-muted-foreground">
        was retried{RETRY_RUNNERS[data.runner]} because {RETRY_REASONS[data.kind](data.failedOn)}
      </span>
    </Row>
  );
}

// The runner's Performance key, so its hover card can find it: a deleted or unclaimed machine has
// no id, and reads as a self-hosted runner.
function runnerKey(runner: ActivityRunner) {
  if (runner.type === "machine")
    return runner.machineId ? `machine:${runner.machineId}` : "self-hosted:";
  return runner.type === "hosted" ? `${runner.provider}:${runner.label}` : `github:${runner.label}`;
}
