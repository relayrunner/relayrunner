import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
  Cloud,
  Laptop,
  LoaderCircle,
  Lock,
  Pause,
  Play,
  Plug,
  Plus,
  Unplug,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  duration,
  getActivity,
  timeAgo,
  type ActivityFilter,
  type ActivityItem,
  type ActivityJob,
  type ActivityPage,
} from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import {
  getCheckSavings,
  minutes,
  money,
  sampleCheckSavings,
  type FreeCheckSavings,
} from "@/lib/usage";
import { failureText, jobNames, walkLines, walkSummary, type RouteWalk } from "@/lib/route-walk";

// Fast enough that a push shows up within seconds, without a live connection.
const POLL_MS = 5_000;

export const Route = createFileRoute("/_authed/_workspace/activity")({
  loader: (): Promise<ActivityPage> =>
    authDisabled ? Promise.resolve(samplePage(undefined)) : getActivity(),
  component: ActivityPage,
});

const FILTERS: { value: ActivityFilter | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "job", label: "Jobs" },
  { value: "check", label: "Checks" },
  { value: "machine", label: "Machines" },
  { value: "member", label: "Members" },
];

function ActivityPage() {
  const first = Route.useLoaderData();
  const [filter, setFilter] = useState<ActivityFilter | undefined>(undefined);
  const [latest, setLatest] = useState(first);
  const [older, setOlder] = useState<ActivityItem[]>([]);
  // Where the next older page starts, once one has been loaded. Before that it's the newest page's.
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [savings, setSavings] = useState<FreeCheckSavings | null>(null);

  useEffect(() => {
    if (authDisabled) {
      setSavings(sampleCheckSavings(30));
      return;
    }
    getCheckSavings(30)
      .then(setSavings)
      .catch(() => undefined); // The log works without it.
  }, []);

  // Refresh the newest page while the tab is visible, and right away when the filter changes.
  // Older pages don't change much, so they're left as loaded.
  useEffect(() => {
    if (authDisabled) return;
    let current = true;
    const refresh = () =>
      getActivity({ filter })
        .then((page) => current && setLatest(page))
        .catch(() => undefined); // Keep showing the last good page; the next tick retries.
    const timer = setInterval(() => {
      setNow(Date.now());
      if (document.visibilityState === "visible") void refresh();
    }, POLL_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [filter]);

  function chooseFilter(next: ActivityFilter | undefined) {
    if (next === filter) return;
    setFilter(next);
    setOlder([]);
    setOlderCursor(null);
    if (authDisabled) {
      setLatest(samplePage(next));
      return;
    }
    getActivity({ filter: next })
      .then(setLatest)
      .catch(() => undefined);
  }

  const cursor = older.length ? olderCursor : latest.nextBefore;

  async function loadOlder() {
    if (cursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await getActivity({ before: cursor, filter });
      setOlder((items) => [...items, ...page.items]);
      setOlderCursor(page.nextBefore);
    } finally {
      setLoadingOlder(false);
    }
  }

  const seen = new Set(latest.items.map((item) => item.id));
  const items = [...latest.items, ...older.filter((item) => !seen.has(item.id))];

  return (
    <section>
      <PageHeader title="Activity">
        Routed jobs, free checks, machine events and member changes, newest first.
      </PageHeader>
      <div className="grid max-w-4xl gap-2">
        <div role="group" aria-label="Show" className="flex gap-1.5">
          {FILTERS.map(({ value, label }) => (
            <Button
              key={label}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => chooseFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
        {savings && savings.checks > 0 && (filter === undefined || filter === "check") && (
          <SavingsBanner savings={savings} />
        )}
        {items.length === 0 ? (
          <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
            {filter === "check" ? (
              <>
                Nothing yet. Turn on a free check with{" "}
                <span className="font-mono text-foreground">relayrunner.yml</span> in a connected
                repo, and its check runs show up here.
              </>
            ) : filter === "machine" ? (
              <>Nothing yet. Machines show up here when they enroll, connect or disconnect.</>
            ) : filter === "member" ? (
              <>Nothing yet. Invites and new members show up here.</>
            ) : (
              <>
                Nothing yet. Add a{" "}
                <span className="font-mono text-foreground">relayrunner/actions</span> relay job to
                a workflow in a connected org, push, and its jobs show up here.
              </>
            )}
          </p>
        ) : (
          <ul className="grid gap-2">
            {items.map((item) =>
              item.job ? (
                <JobRow key={item.id} job={item.job} now={now} />
              ) : item.type === "job.unroutable" ? (
                <UnroutableRow key={item.id} item={item} now={now} />
              ) : item.type === "check.completed" ? (
                <CheckRow key={item.id} item={item} now={now} />
              ) : (
                <EventRow key={item.id} item={item} now={now} />
              ),
            )}
          </ul>
        )}
        {cursor !== null && (
          <Button
            variant="outline"
            size="sm"
            className="justify-self-start"
            disabled={loadingOlder}
            onClick={() => void loadOlder()}
          >
            {loadingOlder ? "Loading…" : "Show older"}
          </Button>
        )}
      </div>
    </section>
  );
}

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
    case "machine.revoked":
      return item.data.source === "github" ? "was removed from RelayRunner" : "was revoked";
    case "job.routed":
      return "routed a job";
    case "job.unroutable":
      return "couldn't route a job";
    case "check.completed":
      return item.data.conclusion === "success" ? "passed" : "failed";
    case "member.invited":
    case "member.invite_canceled":
    case "member.joined":
    case "member.removed":
      return memberSentence(item);
  }
}

// Member events lead with who did it: "Atticus invited ada@example.com as an admin".
function memberSentence(item: ActivityItem) {
  switch (item.type) {
    case "member.invited":
      return `invited ${item.data.email} as ${article(item.data.role)}`;
    case "member.invite_canceled":
      return `cancelled the invite for ${item.data.email}`;
    case "member.joined":
      return `joined as ${article(item.data.role)}`;
    case "member.removed":
      return item.data.left ? "left the workspace" : `removed ${item.data.memberName}`;
    default:
      return "";
  }
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
  "machine.revoked": Ban,
  "member.removed": UserMinus,
  "job.routed": Laptop,
  "job.unroutable": Ban,
  "check.completed": CircleCheck,
  "member.invited": UserPlus,
  "member.invite_canceled": UserX,
  "member.joined": UserCheck,
} as const;

const ICON = "size-3.5 shrink-0";

// Every Activity row: an icon, one line of text that ends in "…" when it doesn't fit (hover shows
// all of it), and the time pinned on the right. A row with `toggle` gets a chevron before the time
// that shows `detail` under the line, indented to the text. The chevron sits outside the
// truncated text so it can always be reached, even when a phone cuts the reason off.
function Row({
  icon,
  at,
  now,
  toggle,
  detail,
  why = "why it ran here",
  children,
}: {
  icon: ReactNode;
  at: string;
  now: number;
  toggle?: Toggle;
  // What the chevron shows, for its label: "Show why it ran here".
  why?: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="min-w-0 px-4 py-1.5 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        {icon}
        <p
          className="min-w-0 flex-1 truncate"
          ref={(el) => {
            if (el) el.title = el.textContent ?? "";
          }}
        >
          {children}
        </p>
        {toggle && (
          <button
            type="button"
            onClick={toggle.onToggle}
            aria-expanded={toggle.open}
            aria-label={toggle.open ? `Hide ${why}` : `Show ${why}`}
            title={toggle.open ? "Hide why" : "Show why"}
            className="-my-1 shrink-0 cursor-pointer rounded-sm p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRight
              aria-hidden
              className={`size-3.5 transition-transform ${toggle.open ? "rotate-90" : ""}`}
            />
          </button>
        )}
        <span
          className="shrink-0 text-xs text-muted-foreground tabular-nums"
          title={new Date(at).toLocaleString()}
        >
          {timeAgo(at, now)}
        </span>
      </div>
      {toggle?.open && detail}
    </li>
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

const LINE_STATES = {
  skipped: "skipped",
  ran: "ran it",
  not_tried: "not tried",
} as const;

// How the pick walked the runner order, one log line per step: "├ 1 machine  skipped · no
// machine with macOS was online and idle".
function WalkLines({ walk, runner }: { walk: RouteWalk; runner: string | null }) {
  const lines = walkLines(walk, runner);
  return (
    <ul
      aria-label="How RelayRunner walked your runner order"
      className="mt-1 grid gap-0.5 pl-[22px] font-mono text-xs text-muted-foreground"
    >
      {lines.map((line, index) => (
        <li
          key={`${line.key}-${line.state}`}
          className="break-words sm:truncate"
          ref={(el) => {
            if (el) el.title = el.textContent ?? "";
          }}
        >
          <span aria-hidden className="text-muted-foreground/50">
            {index === lines.length - 1 ? "└ " : "├ "}
          </span>
          <span className="text-foreground/75">
            {line.position ?? "–"} {line.key}
          </span>{" "}
          <span className={line.state === "ran" ? "text-go" : undefined}>
            {LINE_STATES[line.state]}
          </span>
          {line.text && (line.state === "ran" ? ` ${line.text}` : ` · ${line.text}`)}
        </li>
      ))}
    </ul>
  );
}

// A one-line row for anything that isn't a job: "Atticus's MacBook connected · 2m ago".
function EventRow({ item, now }: { item: ActivityItem; now: number }) {
  const Icon = EVENT_ICONS[item.type];
  const online = item.type === "machine.connected";
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
      <span className="font-medium">{item.machine?.name ?? "A machine"}</span>{" "}
      <span className="text-muted-foreground">{sentence(item)}</span>
      {item.actor && <span className="text-muted-foreground"> by {item.actor.name}</span>}
    </Row>
  );
}

// What happened to the job, and where: "passed on", "waiting for", ...
function jobVerb(job: ActivityJob) {
  if (job.status === "in_progress") return "running on";
  if (job.status !== "completed")
    return job.runner.type === "machine" ? "waiting for" : "queued for";
  if (job.conclusion === "success") return "passed on";
  if (job.conclusion === "failure" || job.conclusion === "timed_out") return "failed on";
  return `${job.conclusion?.replace("_", " ") ?? "finished"} on`;
}

function JobIcon({ job }: { job: ActivityJob }) {
  const base = ICON;
  if (job.status === "in_progress")
    return <LoaderCircle aria-label="Running" className={`${base} animate-spin text-run`} />;
  if (job.status !== "completed")
    return <Clock aria-label="Queued" className={`${base} text-muted-foreground`} />;
  if (job.conclusion === "success")
    return <CircleCheck aria-label="Passed" className={`${base} text-go`} />;
  if (job.conclusion === "failure" || job.conclusion === "timed_out")
    return <CircleX aria-label="Failed" className={`${base} text-destructive`} />;
  return <CircleMinus aria-label="Finished" className={`${base} text-muted-foreground`} />;
}

// A row in the same shape as EventRow, naming the job the way GitHub does ("workflow / job"):
// "RelayRunner dev / test passed on Atticus's MacBook ·
// relayrunner-ci-tests · main · 1m 30s", then the time. The job name opens the job on
// GitHub, the workflow name opens its run.
function JobRow({ job, now }: { job: ActivityJob; now: number }) {
  const [open, setOpen] = useState(false);
  const took = duration(job, now);
  const { runner, walk } = job;
  const RunnerIcon = runner.type === "machine" ? Laptop : Cloud;
  // GitHub never sent the job anywhere: a job it needed failed, so its runs-on was never worked
  // out. Usually folded into its relay's "couldn't run" entry; this row is for runs without one.
  const unrouted = runner.type === "github" && !runner.label;
  const runnerName =
    runner.type === "machine" ? (runner.name ?? "a self-hosted machine") : runner.label;
  const summary = walk ? walkSummary(walk) : null;
  const toggle = summary ? { open, onToggle: () => setOpen(!open) } : undefined;
  return (
    <Row
      icon={<JobIcon job={job} />}
      at={job.createdAt}
      now={now}
      toggle={toggle}
      detail={walk && <WalkLines walk={walk} runner={runnerName} />}
    >
      <a
        href={job.runUrl}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground hover:underline"
        title="Open the run on GitHub"
      >
        {job.workflow ?? "Workflow"}
      </a>
      <span className="text-muted-foreground"> / </span>
      <a
        href={job.url}
        target="_blank"
        rel="noreferrer"
        className="font-medium hover:underline"
        title="Open the job on GitHub"
      >
        {job.name}
      </a>{" "}
      {unrouted ? (
        <>
          <span className="text-muted-foreground">{jobVerb(job).replace(/ (on|for)$/, "")}</span>{" "}
          <Reason text="not routed" tone="info" />
        </>
      ) : (
        <>
          <span className="text-muted-foreground">{jobVerb(job)}</span>{" "}
          <span
            className="font-medium"
            title={job.runnerName ? `Ran on ${job.runnerName}` : "Not picked up yet"}
          >
            <RunnerIcon
              aria-hidden
              className="mr-1 inline size-3 align-[-0.1em] text-muted-foreground"
            />
            <span className={runner.type !== "machine" ? "font-mono text-xs" : undefined}>
              {runnerName}
            </span>
          </span>
        </>
      )}
      {summary && (
        <>
          {" "}
          <Reason text={summary.text} tone={summary.tone} toggle={toggle} />
        </>
      )}
      <span className="text-xs text-muted-foreground">
        {" · "}
        {job.private && (
          <Lock aria-label="Private repo" className="mr-1 inline size-3 align-[-0.1em]" />
        )}
        <span className="font-mono">{job.repository}</span>
        {job.branch && (
          <>
            {" · "}
            <span className="font-mono">{job.branch}</span>
          </>
        )}
        {took && <span className="tabular-nums">{` · ${took}`}</span>}
      </span>
    </Row>
  );
}

// The last 30 days of free checks, above the log: "Free checks saved 200 billed minutes ($0.84)".
function SavingsBanner({ savings }: { savings: FreeCheckSavings }) {
  return (
    <p className="rounded-xl border bg-card px-4 py-2.5 text-sm">
      <Zap aria-hidden className="mr-1.5 inline size-3.5 align-[-0.15em] text-go" />
      Free checks saved{" "}
      <span className="font-medium tabular-nums">
        {minutes(savings.checks)} billed {savings.checks === 1 ? "minute" : "minutes"}
      </span>
      {savings.savedCost > 0 && <span className="tabular-nums"> ({money(savings.savedCost)})</span>}{" "}
      <span className="text-muted-foreground">
        in the last {savings.days} days, one per check or lint run.
      </span>{" "}
      <Link to="/usage" className="text-muted-foreground hover:text-foreground hover:underline">
        See usage
      </Link>
    </p>
  );
}

// A check that ran with no Actions runner: "PR title passed on #12 · no runner · acme/app". The
// check opens its run on GitHub, the number opens the pull request. A lint run from a native job
// has no pull request, so it names its commit: "Lint failed on 4f9c2e1".
function CheckRow({
  item,
  now,
}: {
  item: Extract<ActivityItem, { type: "check.completed" }>;
  now: number;
}) {
  const { data } = item;
  const passed = data.conclusion === "success";
  const Icon = passed ? CircleCheck : CircleX;
  const on =
    data.pullRequest === null
      ? {
          path: `commit/${data.headSha}/checks`,
          title: "Open the commit's checks on GitHub",
          label: data.headSha.slice(0, 7),
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
      icon={
        <Icon
          aria-label={passed ? "Passed" : "Failed"}
          className={`${ICON} ${passed ? "text-go" : "text-destructive"}`}
        />
      }
      at={item.occurredAt}
      now={now}
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
      <span className="text-muted-foreground">{sentence(item)} on</span>{" "}
      <a
        href={`https://github.com/${data.repository}/${on.path}`}
        target="_blank"
        rel="noreferrer"
        className={`font-medium hover:underline ${on.className}`}
        title={on.title}
      >
        {on.label}
      </a>{" "}
      <span className="text-go" title="Ran with no Actions runner: no Actions minute billed">
        <Zap aria-hidden className="mr-0.5 inline size-3 align-[-0.1em]" />
        no runner, saved a minute
      </span>
      <span className="text-xs text-muted-foreground">
        {" · "}
        <span className="font-mono">{data.repository}</span>
      </span>
    </Row>
  );
}

// A run whose relay failed fast because nothing in the runner order could take it, told as the jobs
// that couldn't run: "RelayRunner dev / build and test couldn't run no idle machine with macOS ·
// repo". The relay itself isn't named: it's how routing works, not a job anyone thinks about. Until
// GitHub reports the jobs skipped, it's the run: "RelayRunner dev couldn't run".
function UnroutableRow({
  item,
  now,
}: {
  item: Extract<ActivityItem, { type: "job.unroutable" }>;
  now: number;
}) {
  const [open, setOpen] = useState(false);
  const { data } = item;
  const runUrl = `https://github.com/${data.repository}/actions/runs/${data.runId}`;
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
    >
      <a
        href={runUrl}
        target="_blank"
        rel="noreferrer"
        className="text-muted-foreground hover:text-foreground hover:underline"
        title="Open the run on GitHub"
      >
        {data.workflow ?? "Workflow"}
      </a>
      {names && (
        <>
          <span className="text-muted-foreground"> / </span>
          <span className="font-medium">{names}</span>
        </>
      )}{" "}
      <span className="text-destructive">couldn't run</span>{" "}
      <Reason text={failureText(data.reason)} tone="failure" toggle={toggle} />
      <span className="text-xs text-muted-foreground">
        {" · "}
        <span className="font-mono">{data.repository}</span>
      </span>
    </Row>
  );
}

// Example entries for `VITE_AUTH_DISABLED=true` dev builds, which have no API.
function samplePage(filter: ActivityFilter | undefined): ActivityPage {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const runs = "https://github.com/relayrunner/relayrunner-ci-tests/actions/runs";
  const job = (id: number, minutesAgo: number, rest: Partial<ActivityJob>): ActivityJob => ({
    id,
    repository: "relayrunner/relayrunner-ci-tests",
    private: true,
    runId: id * 10,
    runAttempt: 1,
    workflow: "RelayRunner dev",
    name: "test",
    runner: { type: "github", label: "ubuntu-latest" },
    walk: null,
    runnerName: null,
    branch: "main",
    sha: "abc123",
    status: "queued",
    conclusion: null,
    createdAt: at(minutesAgo),
    startedAt: null,
    completedAt: null,
    url: `${runs}/${id * 10}/job/${id}`,
    runUrl: `${runs}/${id * 10}`,
    ...rest,
  });
  const mac = { id: "m1", name: "Atticuss-MacBook-Pro.local" };
  const relay = { machine: ["self-hosted"], github: ["ubuntu-latest"], blacksmith: [] };
  const items: ActivityItem[] = [
    {
      id: 13,
      type: "job.routed",
      data: {},
      occurredAt: at(0.05),
      actor: null,
      machine: null,
      job: job(6, 0.05, {
        name: "test (macos)",
        runnerName: "GitHub Actions 14",
        status: "in_progress",
        startedAt: at(0.04),
        walk: {
          step: "github",
          skipped: [{ key: "machine", reason: "machine_paused", paused: [mac.name] }],
          notInOrder: [],
          machine: ["macOS", "ARM64"],
          github: ["macos-latest"],
          blacksmith: [],
        },
      }),
    },
    {
      id: 12,
      type: "machine.paused",
      data: { machineName: mac.name, via: "dashboard" },
      occurredAt: at(0.15),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
    {
      id: 11,
      type: "machine.resumed",
      data: { machineName: mac.name, via: "cli" },
      occurredAt: at(20),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 10,
      type: "job.unroutable",
      data: {
        repository: "relayrunner/relayrunner-ci-tests",
        runId: 90,
        runAttempt: 1,
        workflow: "RelayRunner dev",
        job: "relay",
        reason: `No runner available: the only machine that fits, ${mac.name}, is paused.`,
        walk: {
          step: null,
          skipped: [
            { key: "machine", reason: "machine_paused", paused: [mac.name] },
            { key: "github", reason: "not_configured" },
          ],
          notInOrder: [],
          machine: ["macOS", "ARM64"],
          github: [],
          blacksmith: [],
        },
      },
      occurredAt: at(0.1),
      actor: null,
      machine: null,
      job: null,
      jobsNotRun: ["test (macos)", "deploy"],
    },
    {
      id: 9,
      type: "job.routed",
      data: {},
      occurredAt: at(3),
      actor: null,
      machine: null,
      job: job(5, 3, {
        runner: { type: "blacksmith", label: "blacksmith-2vcpu-ubuntu-2404" },
        runnerName: "blacksmith-2vcpu-ubuntu-2404-x7k2p",
        status: "completed",
        conclusion: "success",
        startedAt: at(2.9),
        completedAt: at(0.7),
        walk: {
          step: "blacksmith",
          skipped: [{ key: "machine", reason: "no_machine" }],
          notInOrder: [],
          machine: ["macOS", "ARM64"],
          github: ["ubuntu-latest"],
          blacksmith: ["blacksmith-2vcpu-ubuntu-2404"],
        },
      }),
    },
    {
      id: 8,
      type: "job.routed",
      data: {},
      occurredAt: at(9),
      actor: null,
      machine: null,
      job: job(4, 9, {
        runner: { type: "machine", machineId: "m1", name: mac.name },
        runnerName: "Atticus-s-MacBook-0123456789ab",
        status: "completed",
        conclusion: "success",
        startedAt: at(8.9),
        completedAt: at(7.4),
        walk: { step: "machine", skipped: [], notInOrder: ["github"], ...relay },
      }),
    },
    {
      id: 7,
      type: "job.routed",
      data: {},
      occurredAt: at(0.2),
      actor: null,
      machine: null,
      job: job(3, 0.2, {
        workflow: "RelayRunner machine test",
        name: "machine",
        runner: { type: "machine", machineId: "m1", name: mac.name },
        runnerName: "Atticus-s-MacBook-0123456789ab",
        status: "in_progress",
        startedAt: at(0.1),
        walk: { step: "machine", skipped: [], notInOrder: [], ...relay },
      }),
    },
    {
      id: 6,
      type: "machine.connected",
      data: { machineName: mac.name, runnerVersion: "2.330.0" },
      occurredAt: at(1),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 5,
      type: "machine.disconnected",
      data: { machineName: mac.name, reason: "timeout" },
      occurredAt: at(25),
      actor: null,
      machine: mac,
      job: null,
    },
    {
      id: 4,
      type: "job.routed",
      data: {},
      occurredAt: at(38),
      actor: null,
      machine: null,
      job: job(2, 38, {
        private: false,
        repository: "relayrunner/actions",
        runnerName: "GitHub Actions 7",
        status: "completed",
        conclusion: "success",
        startedAt: at(37.5),
        completedAt: at(36),
        walk: {
          step: "github",
          skipped: [{ key: "machine", reason: "public_repo" }],
          notInOrder: [],
          ...relay,
        },
      }),
    },
    {
      id: 3,
      type: "job.routed",
      data: {},
      occurredAt: at(180),
      actor: null,
      machine: null,
      // A run from before relays failed fast: GitHub skipped the job and never sent it anywhere.
      job: job(1, 180, {
        name: "deploy",
        runner: { type: "github", label: "" },
        status: "completed",
        conclusion: "skipped",
        completedAt: at(180),
      }),
    },
    {
      id: 9,
      type: "machine.revoked",
      data: { machineName: "zach-studio" },
      occurredAt: at(14.9),
      actor: { id: "u1", name: "Atticus White" },
      machine: { id: "m2", name: "zach-studio" },
      job: null,
    },
    {
      id: 8,
      type: "member.removed",
      data: { memberName: "Zach", left: false },
      occurredAt: at(15),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 12,
      type: "member.joined",
      data: { name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
      occurredAt: at(20),
      actor: { id: "u2", name: "Ada Lovelace" },
      machine: null,
      job: null,
    },
    {
      id: 11,
      type: "member.invited",
      data: { email: "ada@example.com", role: "admin" },
      occurredAt: at(45),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 51,
      type: "check.completed",
      data: {
        check: "Lint",
        repository: "relayrunner/relayrunner-ci-tests",
        repositoryId: 1,
        pullRequest: null,
        headSha: "4f9c2e1a7b",
        conclusion: "failure",
        url: null,
      },
      occurredAt: at(1),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 50,
      type: "check.completed",
      data: {
        check: "PR title",
        repository: "relayrunner/relayrunner-ci-tests",
        repositoryId: 1,
        pullRequest: 42,
        headSha: "abc123",
        conclusion: "success",
        url: "https://github.com/relayrunner/relayrunner-ci-tests/runs/1",
      },
      occurredAt: at(2),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 2,
      type: "machine.enrolled",
      data: { machineName: mac.name, os: "macos", arch: "arm64" },
      occurredAt: at(60),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
  ];
  items.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return {
    nextBefore: null,
    items: filter ? items.filter((item) => item.type.startsWith(`${filter}.`)) : items,
  };
}
