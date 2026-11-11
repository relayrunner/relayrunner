import { Link, createFileRoute } from "@tanstack/react-router";
import {
  Ban,
  ChevronRight,
  CircleCheck,
  CircleMinus,
  CircleX,
  Clock,
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
  TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ProviderLink } from "@/components/provider-link";
import { ProviderMark } from "@/components/providers";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  duration,
  getActivity,
  getActivityOptions,
  timeAgo,
  type ActivityFilter,
  type ActivityItem,
  type ActivityJob,
  type ActivityOptions,
  type ActivityPage,
  type ActivityQuery,
  type ActivityResult,
  type ActivityStarter,
  type ActivityStarters,
} from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { DAY_MS } from "@/lib/job-times";
import { useLiveRefresh } from "@/lib/live-refresh";
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

const TYPES: { value: ActivityFilter | undefined; label: string }[] = [
  { value: undefined, label: "All" },
  { value: "job", label: "Jobs" },
  { value: "check", label: "Checks" },
  { value: "machine", label: "Machines" },
  { value: "member", label: "Members" },
];
const RANGES = [
  { days: 1, label: "Last 24 hours" },
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
];
const RESULTS: { value: ActivityResult; label: string }[] = [
  { value: "passed", label: "Passed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "skipped", label: "Skipped" },
  { value: "running", label: "In progress" },
];
// A Select needs a value for "no filter".
const ANY = "any";

/** The filters, kept in the URL so a filtered view can be shared or bookmarked. */
type ActivitySearch = {
  type?: ActivityFilter;
  days?: number;
  repo?: string;
  result?: ActivityResult;
  machine?: string;
};

function oneOf<T>(values: readonly T[], value: unknown): T | undefined {
  return values.find((option) => option === value);
}
const text = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;

// Which filters mean something for each kind of event: a member change has no repo, result or
// machine; a check runs on no machine; a machine event has no repo or result.
function appliesTo(type: ActivityFilter | undefined) {
  const jobOrCheck = type === undefined || type === "job" || type === "check";
  return {
    repo: jobOrCheck,
    result: jobOrCheck,
    machine: type === undefined || type === "job" || type === "machine",
  };
}

function toQuery(search: ActivitySearch): ActivityQuery {
  return {
    filter: search.type,
    since: search.days ? Date.now() - search.days * DAY_MS : undefined,
    repository: search.repo,
    result: search.result,
    machine: search.machine,
  };
}

export const Route = createFileRoute("/_authed/_workspace/activity")({
  // Drops the filters that don't fit the kind of event shown, so nothing hidden narrows the log.
  validateSearch: (search: Record<string, unknown>): ActivitySearch => {
    const type = oneOf(
      TYPES.map((option) => option.value),
      search.type,
    );
    const applies = appliesTo(type);
    return {
      type,
      days: oneOf(
        RANGES.map((range) => range.days),
        search.days,
      ),
      repo: applies.repo ? text(search.repo) : undefined,
      result: applies.result
        ? oneOf(
            RESULTS.map((result) => result.value),
            search.result,
          )
        : undefined,
      machine: applies.machine ? text(search.machine) : undefined,
    };
  },
  loaderDeps: ({ search }) => search,
  loader: ({ deps }): Promise<ActivityPage> =>
    authDisabled ? Promise.resolve(samplePage(deps)) : getActivity(toQuery(deps)),
  component: ActivityPage,
});

function ActivityPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [savings, setSavings] = useState<FreeCheckSavings | null>(null);
  const [options, setOptions] = useState<ActivityOptions>({ repositories: [], machines: [] });

  useEffect(() => {
    if (authDisabled) {
      setSavings(sampleCheckSavings(30));
      setOptions(sampleOptions());
      return;
    }
    // The log works without either.
    getCheckSavings(30)
      .then(setSavings)
      .catch(() => undefined);
    getActivityOptions()
      .then(setOptions)
      .catch(() => undefined);
  }, []);

  const update = (patch: ActivitySearch) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }) });
  const narrowed = Boolean(search.days || search.repo || search.result || search.machine);

  return (
    <section>
      <PageHeader title="Activity">
        Routed jobs, free checks, machine events and member changes, newest first.
      </PageHeader>
      <div className="grid max-w-4xl gap-2">
        <Filters search={search} options={options} narrowed={narrowed} onChange={update} />
        {savings &&
          savings.checks > 0 &&
          !narrowed &&
          (!search.type || search.type === "check") && <SavingsBanner savings={savings} />}
        <Log search={search} narrowed={narrowed} onClear={() => update(CLEARED)} />
      </div>
    </section>
  );
}

const CLEARED: ActivitySearch = {
  days: undefined,
  repo: undefined,
  result: undefined,
  machine: undefined,
};

function Filters({
  search,
  options,
  narrowed,
  onChange,
}: {
  search: ActivitySearch;
  options: ActivityOptions;
  narrowed: boolean;
  onChange: (patch: ActivitySearch) => void;
}) {
  const applies = appliesTo(search.type);
  // A repo or machine from a shared link still shows, even if this workspace's lists lack it.
  const repositories =
    search.repo && !options.repositories.includes(search.repo)
      ? [search.repo, ...options.repositories]
      : options.repositories;
  const machines =
    search.machine && !options.machines.some((machine) => machine.id === search.machine)
      ? [{ id: search.machine, name: "Unknown machine" }, ...options.machines]
      : options.machines;

  return (
    <div className="grid gap-2">
      <div role="group" aria-label="Show" className="flex gap-1.5">
        {TYPES.map(({ value, label }) => (
          <Button
            key={label}
            size="sm"
            variant={search.type === value ? "secondary" : "ghost"}
            aria-pressed={search.type === value}
            onClick={() => value !== search.type && onChange({ type: value })}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <FilterSelect
          label="Date"
          value={search.days?.toString()}
          any="Any time"
          options={RANGES.map((range) => ({ value: String(range.days), label: range.label }))}
          onChange={(value) => onChange({ days: value ? Number(value) : undefined })}
        />
        {applies.repo && repositories.length > 0 && (
          <FilterSelect
            label="Repo"
            value={search.repo}
            any="All repos"
            options={repositories.map((name) => ({ value: name, label: name }))}
            onChange={(repo) => onChange({ repo })}
          />
        )}
        {applies.result && (
          <FilterSelect
            label="Result"
            value={search.result}
            any="Any result"
            options={RESULTS}
            onChange={(result) => onChange({ result })}
          />
        )}
        {applies.machine && machines.length > 0 && (
          <FilterSelect
            label="Machine"
            value={search.machine}
            any="All machines"
            options={machines.map((machine) => ({ value: machine.id, label: machine.name }))}
            onChange={(machine) => onChange({ machine })}
          />
        )}
        {narrowed && (
          <Button size="sm" variant="ghost" onClick={() => onChange(CLEARED)}>
            Clear
          </Button>
        )}
      </div>
    </div>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  any,
  options,
  onChange,
}: {
  label: string;
  value: T | undefined;
  any: string;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
}) {
  return (
    <Select
      value={value ?? ANY}
      onValueChange={(next) => onChange(next === ANY ? undefined : (next as T))}
    >
      <SelectTrigger size="sm" aria-label={label} className="max-w-72">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANY}>{any}</SelectItem>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// The log for the current filters. The loader fetches the newest page whenever they change.
function Log({
  search,
  narrowed,
  onClear,
}: {
  search: ActivitySearch;
  narrowed: boolean;
  onClear: () => void;
}) {
  const first = Route.useLoaderData();
  const [latest, setLatest] = useState(first);
  const [older, setOlder] = useState<ActivityItem[]>([]);
  // Where the next older page starts, once one has been loaded. Before that it's the newest page's.
  const [olderCursor, setOlderCursor] = useState<number | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // New filters bring a new first page: start over from it.
  useEffect(() => {
    setLatest(first);
    setOlder([]);
    setOlderCursor(null);
  }, [first]);

  // Refresh the newest page while someone is looking (paused while the tab is hidden or idle, see
  // lib/live-refresh.ts). Older pages don't change much, so they're left as loaded.
  const { type, days, repo, result, machine } = search;
  const filters = JSON.stringify({ type, days, repo, result, machine });
  const currentFilters = useRef(filters);
  currentFilters.current = filters;
  useLiveRefresh(
    () => {
      setNow(Date.now());
      getActivity(toQuery({ type, days, repo, result, machine }))
        // A page for filters that changed meanwhile is dropped.
        .then((page) => currentFilters.current === filters && setLatest(page))
        .catch(() => undefined); // Keep showing the last good page; the next tick retries.
    },
    { intervalMs: POLL_MS, enabled: !authDisabled },
  );

  const cursor = older.length ? olderCursor : latest.nextBefore;

  async function loadOlder() {
    if (cursor === null) return;
    setLoadingOlder(true);
    try {
      const page = await getActivity({ ...toQuery(search), before: cursor });
      setOlder((items) => [...items, ...page.items]);
      setOlderCursor(page.nextBefore);
    } finally {
      setLoadingOlder(false);
    }
  }

  const seen = new Set(latest.items.map((item) => item.id));
  const items = [...latest.items, ...older.filter((item) => !seen.has(item.id))];

  return (
    <>
      {items.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          {narrowed ? (
            <>
              Nothing matches these filters.{" "}
              <button type="button" className="text-foreground underline" onClick={onClear}>
                Clear filters
              </button>
            </>
          ) : search.type === "check" ? (
            <>
              Nothing yet. Turn on a free check with{" "}
              <span className="font-mono text-foreground">relayrunner.yml</span> in a connected
              repo, and its check runs show up here.
            </>
          ) : search.type === "machine" ? (
            <>Nothing yet. Machines show up here when they enroll, connect or disconnect.</>
          ) : search.type === "member" ? (
            <>Nothing yet. Invites and new members show up here.</>
          ) : (
            <>
              Nothing yet. Add a{" "}
              <span className="font-mono text-foreground">relayrunner/actions</span> relay job to a
              workflow in a connected repo, push, and its jobs show up here.
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
    </>
  );
}

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
    case "machine.revoked":
      return item.data.source === "github" ? "was removed from RelayRunner" : "was revoked";
    case "job.routed":
      return "routed a job";
    case "job.unroutable":
      return "couldn't route a job";
    case "check.completed":
      return item.data.conclusion === "success" ? "passed" : "failed";
    case "minutes.overage":
      return "went past its included GitHub Actions minutes";
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
  "machine.sharing_changed": Lock,
  "machine.revoked": Ban,
  "member.removed": UserMinus,
  "job.routed": Laptop,
  "job.unroutable": Ban,
  "check.completed": CircleCheck,
  "member.invited": UserPlus,
  "member.invite_canceled": UserX,
  "member.joined": UserCheck,
  "minutes.overage": TriangleAlert,
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
  aside,
  children,
}: {
  icon: ReactNode;
  // Pinned before the time on wider screens, outside the truncated line: who started a job.
  aside?: ReactNode;
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
        {aside}
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
      aside={<StarterAside starters={job.starters} />}
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
            <ProviderLink provider={runner.type}>
              <ProviderMark
                provider={runner.type}
                className="mr-1 inline-flex size-4 rounded-[4px] align-[-0.2em]"
              />
              <span className={runner.type !== "machine" ? "font-mono text-xs" : undefined}>
                {runnerName}
              </span>
            </ProviderLink>
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
        <span className="sm:hidden">
          <StartedBy starters={job.starters} />
        </span>
        {took && <span className="tabular-nums">{` · ${took}`}</span>}
      </span>
    </Row>
  );
}

// Who started the run, after the repo and branch: " · started by Atticus", plus ", re-run by
// Zach" when someone else started this attempt. A member shows by name; a bot or someone outside
// the workspace by GitHub login. Nothing for runs from before RelayRunner kept this.
function StartedBy({ starters, bare }: { starters: ActivityStarters; bare?: boolean }) {
  const { startedBy, rerunBy } = starters;
  if (!startedBy && !rerunBy) return null;
  return (
    <>
      {!bare && " · "}
      {startedBy && (
        <>
          {!bare && "started by "}
          <Starter who={startedBy} />
        </>
      )}
      {startedBy && rerunBy && ", "}
      {rerunBy && (
        <>
          re-run by <Starter who={rerunBy} />
        </>
      )}
    </>
  );
}

// The same, pinned beside the time on wider screens so a long row never cuts it off.
function StarterAside({ starters }: { starters: ActivityStarters }) {
  const { startedBy, rerunBy } = starters;
  if (!startedBy && !rerunBy) return null;
  const label = (who: ActivityStarter) => who.member?.name ?? who.login;
  const title = [
    startedBy && `Started by ${label(startedBy)}`,
    rerunBy && `re-run by ${label(rerunBy)}`,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <span
      className="hidden max-w-64 shrink-0 truncate text-xs text-muted-foreground sm:inline"
      title={title}
    >
      <StartedBy starters={starters} bare />
    </span>
  );
}

function Starter({ who }: { who: ActivityStarter }) {
  if (who.member) return <span className="text-foreground/75">{who.member.name}</span>;
  return (
    <span className="font-mono" title={`GitHub account ${who.login}, not in this workspace`}>
      {who.login}
    </span>
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
      aside={item.starters && <StarterAside starters={item.starters} />}
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
        {item.starters && (
          <span className="sm:hidden">
            <StartedBy starters={item.starters} />
          </span>
        )}
      </span>
    </Row>
  );
}

// Example entries for `VITE_AUTH_DISABLED=true` dev builds, which have no API.
function samplePage(search: ActivitySearch): ActivityPage {
  const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
  const runs = "https://github.com/relayrunner/relayrunner-ci-tests/actions/runs";
  const atticus = { login: "atticoos", member: { id: "u1", name: "Atticus White" } };
  const zach = { login: "zach", member: { id: "u2", name: "Zach Ross" } };
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
    starters: { startedBy: atticus, rerunBy: null },
    ...rest,
  });
  const mac = { id: "m1", name: "Atticuss-MacBook-Pro.local" };
  const relay = { machine: ["self-hosted"], github: ["ubuntu-latest"], blacksmith: [] };
  const items: ActivityItem[] = [
    {
      id: 17,
      type: "job.routed",
      data: {},
      occurredAt: at(0.02),
      actor: null,
      machine: null,
      job: job(7, 0.02, {
        name: "test (macos)",
        starters: { startedBy: zach, rerunBy: null },
        runnerName: "GitHub Actions 15",
        status: "in_progress",
        startedAt: at(0.01),
        walk: {
          step: "github",
          skipped: [
            {
              key: "machine",
              reason: "machine_not_shared",
              notShared: [{ machine: mac.name, owner: "Atticus White" }],
            },
          ],
          notInOrder: [],
          machine: ["macOS", "ARM64"],
          github: ["macos-latest"],
          blacksmith: [],
        },
      }),
    },
    {
      id: 16,
      type: "machine.sharing_changed",
      data: { machineName: mac.name, sharing: "anyone" },
      occurredAt: at(0.03),
      actor: { id: "u1", name: "Atticus White" },
      machine: mac,
      job: null,
    },
    {
      id: 15,
      type: "job.routed",
      data: {},
      occurredAt: at(0.02),
      actor: null,
      machine: null,
      job: job(7, 0.02, {
        name: "build",
        runner: { type: "machine", machineId: mac.id, name: mac.name },
        runnerName: `${mac.name}-0123456789ab`,
        status: "in_progress",
        startedAt: at(0.01),
        walk: {
          step: "machine",
          skipped: [
            {
              key: "github",
              reason: "minutes_limit",
              minutes: {
                account: "relayrunner",
                usedMinutes: 1640,
                quotaMinutes: 2000,
                percent: 80,
                burnRatePerHour: 38,
              },
            },
          ],
          notInOrder: [],
          ...relay,
        },
      }),
    },
    {
      id: 14,
      type: "minutes.overage",
      data: {
        account: "acme-labs",
        installationId: 2,
        cycleStart: new Date(Date.UTC(2026, 10, 1)).toISOString(),
        netAmount: 0.67,
      },
      occurredAt: at(3),
      actor: null,
      machine: null,
      job: null,
    },
    {
      id: 13,
      type: "job.routed",
      data: {},
      occurredAt: at(0.05),
      actor: null,
      machine: null,
      job: job(6, 0.05, {
        name: "test (macos)",
        runAttempt: 2,
        starters: { startedBy: atticus, rerunBy: zach },
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
      starters: { startedBy: zach, rerunBy: null },
    },
    {
      id: 9,
      type: "job.routed",
      data: {},
      occurredAt: at(3),
      actor: null,
      machine: null,
      job: job(5, 3, {
        starters: { startedBy: { login: "dependabot[bot]", member: null }, rerunBy: null },
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
      id: 14,
      type: "machine.revoked",
      data: { machineName: "zach-studio" },
      occurredAt: at(14.9),
      actor: { id: "u1", name: "Atticus White" },
      machine: { id: "m2", name: "zach-studio" },
      job: null,
    },
    {
      id: 15,
      type: "member.removed",
      data: { memberName: "Zach", left: false },
      occurredAt: at(15),
      actor: { id: "u1", name: "Atticus White" },
      machine: null,
      job: null,
    },
    {
      id: 16,
      type: "member.joined",
      data: { name: "Ada Lovelace", email: "ada@example.com", role: "admin" },
      occurredAt: at(20),
      actor: { id: "u2", name: "Ada Lovelace" },
      machine: null,
      job: null,
    },
    {
      id: 17,
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
    items: items.filter((item) => sampleMatches(item, search)),
  };
}

// The API's filters, applied to the sample entries (dev builds only; the real log filters on the
// server).
function sampleMatches(item: ActivityItem, search: ActivitySearch) {
  if (search.type && !item.type.startsWith(`${search.type}.`)) return false;
  if (search.days && Date.parse(item.occurredAt) < Date.now() - search.days * DAY_MS) return false;
  if (search.repo) {
    const repo = item.job?.repository ?? ("repository" in item.data ? item.data.repository : null);
    if (repo !== search.repo) return false;
  }
  if (search.machine) {
    const runner = item.job?.runner;
    const machine = item.machine?.id ?? (runner?.type === "machine" ? runner.machineId : null);
    if (machine !== search.machine) return false;
  }
  return !search.result || sampleResult(item) === search.result;
}

function sampleResult(item: ActivityItem): ActivityResult | null {
  if (item.type === "job.unroutable") return "failed";
  const conclusion = item.job
    ? item.job.conclusion
    : "conclusion" in item.data
      ? item.data.conclusion
      : undefined;
  if (conclusion === undefined) return null;
  if (conclusion === null) return "running";
  if (conclusion === "success") return "passed";
  if (conclusion === "failure" || conclusion === "timed_out") return "failed";
  return conclusion as ActivityResult;
}

function sampleOptions(): ActivityOptions {
  return {
    repositories: ["relayrunner/actions", "relayrunner/relayrunner-ci-tests"],
    machines: [{ id: "m1", name: "Atticuss-MacBook-Pro.local" }],
  };
}
