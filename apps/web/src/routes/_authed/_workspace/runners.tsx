import { RUNNER_LABELS, type RunnerKey, type RunnerStep } from "@relayrunner/runner-order";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  CirclePlayIcon,
  CloudIcon,
  CopyIcon,
  LaptopIcon,
  LayoutGridIcon,
  ListFilterIcon,
  ListIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  AddRunner,
  CONNECT_COMMAND,
  CopyCommand,
  GithubRunnersDialog,
} from "@/components/add-runner";
import { SectionBoundary } from "@/components/error-boundary";
import { MacAppButton, MacAppLink, ON_MAC } from "@/components/mac-app";
import { PageHeader } from "@/components/page-header";
import { DOCS_URL } from "@/components/site-footer";
import { GithubIcon } from "@/components/provider-logos";
import { sharingLabel } from "@/components/machine-sharing";
import { OtherMachinesBanner, OtherMachinesDialog } from "@/components/other-machines";
import {
  FOUND_PREVIEW,
  FoundCard,
  FoundRunnerRows,
  MachineCard,
  machineView,
} from "@/components/runner-card";
import { CloudProviderCard } from "@/components/cloud-runners";
import { CloudRunnersTable } from "@/components/cloud-runners-table";
import { TimeRangePicker } from "@/components/range-picker";
import { RunnerList, type RunnerRow } from "@/components/runner-list";
import { NeedsAttention } from "@/components/runner-attention";
import { RunnersNow } from "@/components/runners-now";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { attentionItems } from "@/lib/attention";
import { authDisabled } from "@/lib/auth-client";
import { plural, type Stat } from "@/lib/job-times";
import { NO_LIVE_JOBS } from "@/lib/live-jobs";
import { useLiveRefresh } from "@/lib/live-refresh";
import {
  addableRunners,
  addGithubRunners,
  listGithubRunners,
  machinesQuery,
  type AddableRunner,
  type GitHubRunners,
  type Machine,
  type OtherMachine,
} from "@/lib/machines";
import { PROVIDER_DEFAULT_RANGE, PROVIDER_RANGES, type ProviderSummary } from "@/lib/providers";
import { canManage } from "@/lib/roles";
import {
  CLEARED_FILTERS,
  filterCount,
  INACTIVE_DAYS,
  isInactive,
  joinFilter,
  matchesFilters,
  ownerOf,
  type RunnerSearch,
  splitFilter,
  STATUSES,
  validateRunnerSearch,
} from "@/lib/runner-filters";
import { queryClient } from "@/lib/query";
import {
  cloudRunnersQuery,
  liveJobsQuery,
  machineJobTimesQuery,
  prefetchRunnersPage,
  runnerOrderQuery,
} from "@/lib/runners-page";
import { unlessDefault } from "@/lib/search-params";
import { rangePhrase } from "@/lib/time-range";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { cn } from "@/lib/utils";

// Found runners per workspace, kept for the tab's life so leaving and coming back doesn't wait on
// GitHub again. The page still re-checks in the background on each visit, against the API's
// cached scan, and the Add runners dialog opens with them.
const foundCache = new Map<string, GitHubRunners[]>();
const dismissedFound = new Set<string>();

// How often the page refetches machines while someone is looking, so a machine connecting, going
// quiet or picking up a job shows up. Paused while the tab is hidden or idle (lib/live-refresh.ts).
const REFRESH_MS = 15_000;

// Stand in for lists that haven't loaded, so they don't get a new array each render.
const NO_MACHINES: Machine[] = [];
const NO_OTHERS: OtherMachine[] = [];

// Stands in for job counts that haven't loaded, so the list doesn't get a new object each render.
const NO_JOB_TIMES: Record<string, Stat> = {};

// Whether self-hosted runners show as a list instead of cards, kept per browser.
const LIST_KEY = "relayrunner:runners:list";
// Cloud-hosted as one table rather than a card per provider.
const CLOUD_LIST_KEY = "relayrunner:runners:cloud-list";
// Whether the user closed the card that shows how to connect their own computer, kept per browser.
const CONNECT_DISMISSED_KEY = "relayrunner:runners:connect-dismissed";
// Whether self-hosted cards show their hardware and typical job, kept per browser.
const SHOW_SPECS_KEY = "relayrunner:runners:show-specs";

export const Route = createFileRoute("/_authed/_workspace/runners")({
  validateSearch: validateRunnerSearch,
  // Filters and the cloud table's range apply in the page, so they don't load the runners again.
  shouldReload: ({ cause }) => cause !== "stay",
  // Starts every read and shows the page at once: each section fills in when its own comes back
  // (lib/runners-page.ts), instead of the whole page waiting on the slowest.
  loader: ({ context, location }) => {
    const { cloud } = validateRunnerSearch(location.search as Record<string, unknown>);
    prefetchRunnersPage(
      context.current.workspace.id,
      cloud ?? PROVIDER_DEFAULT_RANGE,
      INACTIVE_DAYS,
    );
  },
  component: RunnersPage,
});

// The runners the workspace supplies, grouped as Self-hosted. Where jobs go is the Router's job;
// the line at the top says what it means right now.
function RunnersPage() {
  const { current } = Route.useRouteContext();
  const router = useRouter();
  // Each read is its own query, so the page draws before any comes back and keeps showing the
  // last answer when a refresh fails; the next tick retries.
  const machinesRead = useQuery(machinesQuery);
  // Null until the first answer, so the page shows skeletons rather than "no runners yet".
  const machinesLoaded = machinesRead.data ?? null;
  const allMachines = machinesLoaded?.machines ?? NO_MACHINES;
  const others = machinesLoaded?.others ?? NO_OTHERS;
  // The jobs running and queued right now, for the top of the page.
  const live = useQuery(liveJobsQuery).data ?? NO_LIVE_JOBS;
  const order = useQuery(runnerOrderQuery(current.workspace.id)).data;

  // Only the machines list and live jobs are refetched: invalidating the route would also re-run
  // the session and workspace guards on every tick.
  const refreshMachines = () => machinesRead.refetch().then(() => undefined);
  const refreshLive = () =>
    queryClient.refetchQueries({ queryKey: liveJobsQuery.queryKey, exact: true });
  useLiveRefresh(
    // The live jobs only show once the workspace has a runner.
    () => Promise.all([refreshMachines(), allMachines.length ? refreshLive() : null]),
    { intervalMs: REFRESH_MS, enabled: !authDisabled },
  );

  // When the machines last came back, for the freshness line and greying out stale numbers.
  const updatedAt = machinesRead.dataUpdatedAt || Date.now();
  const attention = useMemo(() => attentionItems(allMachines, live), [allMachines, live]);

  const editable = canManage(current.role);
  const [showSpecs, setShowSpecs] = useState(() => readFlag(SHOW_SPECS_KEY));
  const [list, setList] = useState(() => readFlag(LIST_KEY));
  const [cloudList, setCloudList] = useState(() => readFlag(CLOUD_LIST_KEY));

  // Runners in connected orgs that aren't added yet, for the found card. Owners and admins only,
  // since only they can add them. It asks GitHub, so it's read once per visit, not on every
  // refresh, and the last answer is kept for the tab so coming back shows it at once.
  const workspaceId = current.workspace.id;
  const [githubOpen, setGithubOpen] = useState(false);
  const [found, setFound] = useState<GitHubRunners[] | null>(
    () => foundCache.get(workspaceId) ?? null,
  );
  const addable = found ? addableRunners(found) : [];
  function keepFound(orgs: GitHubRunners[]) {
    foundCache.set(workspaceId, orgs);
    setFound(orgs);
  }
  const [dismissed, setDismissed] = useState(() => dismissedFound.has(workspaceId));
  async function findRunners() {
    if (!editable) return;
    try {
      const { orgs } = await listGithubRunners({ groups: false });
      keepFound(orgs);
    } catch {
      // Keep showing the last answer; GitHub may just be slow or down.
    }
  }
  useEffect(() => {
    setFound(foundCache.get(workspaceId) ?? null);
    setDismissed(dismissedFound.has(workspaceId));
    // Once per visit and workspace, and not once the card is dismissed: it asks GitHub per repo.
    if (!dismissedFound.has(workspaceId)) void findRunners();
  }, [workspaceId, editable]);
  // Each machine's jobs over the last INACTIVE_DAYS, loaded after the cards so they never wait on
  // it. Null until it answers, so runners added from GitHub aren't hidden as inactive meanwhile.
  const jobTimes: Record<string, Stat> | null =
    useQuery(machineJobTimesQuery(INACTIVE_DAYS)).data ?? null;
  // Self-hosted runners narrowed by the filter menu, kept in the URL. Runners that have been
  // offline with no jobs for INACTIVE_DAYS are hidden unless asked for.
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  function setSearch(next: Partial<RunnerSearch>) {
    void navigate({ search: (prev) => ({ ...prev, ...next }), replace: true, resetScroll: false });
  }
  const rows = useMemo<RunnerRow[]>(
    () =>
      allMachines
        .filter((machine) => !machine.revokedAt)
        .map((machine) => {
          const view = machineView(machine);
          const ran = jobTimes ? (jobTimes[machine.id]?.runs ?? 0) > 0 : undefined;
          return {
            machine,
            view,
            owner: ownerOf(machine, view),
            inactive: isInactive(machine, view, ran),
          };
        }),
    [allMachines, jobTimes],
  );
  const filters = filterCount(search);
  const inactiveCount = rows.filter((row) => row.inactive).length;
  const matching = useMemo(
    () => rows.filter(({ view, owner }) => matchesFilters(view, owner, search)),
    [rows, search],
  );
  const shown = useMemo(
    () => (search.inactive ? matching : matching.filter((row) => !row.inactive)),
    [matching, search.inactive],
  );

  // Cloud runners jobs used in the range (this month unless picked): GitHub-hosted classes, hosted
  // providers, containers. Null until the first answer.
  const cloudRange = search.cloud ?? PROVIDER_DEFAULT_RANGE;
  // Another range keeps the last one's cards up until it's back.
  const cloudRead = useQuery({
    ...cloudRunnersQuery(cloudRange),
    placeholderData: keepPreviousData,
  });
  const cloud: ProviderSummary[] | null = cloudRead.data ?? null;
  // The user's own machines that don't take this workspace's jobs (a workspace joined through
  // GitHub starts with none). The banner can be dismissed per workspace; Add runner still has it.
  const othersKey = `relayrunner:runners:others-dismissed:${workspaceId}`;
  const [othersOpen, setOthersOpen] = useState(false);
  const [othersDismissed, setOthersDismissed] = useState(() => readFlag(othersKey));
  useEffect(() => setOthersDismissed(readFlag(othersKey)), [othersKey]);

  // Also called when the user takes a machine out of this workspace: the banner would otherwise
  // come straight back about the machine they just removed.
  function dismissOthers() {
    saveFlag(othersKey, true);
    setOthersDismissed(true);
  }

  // One click from the page: adds the runner, then refreshes the machines and what's left to add.
  async function addFound(runner: AddableRunner) {
    try {
      const { added } = await addGithubRunners(runner.installationId, [runner.id], runner.repo?.id);
      if (added.length === 0) {
        // Skipped, e.g. its group only allows selected workflows: the dialog says why.
        setGithubOpen(true);
        return;
      }
    } catch {
      setGithubOpen(true);
      return;
    }
    await router.invalidate();
    await findRunners();
  }

  function dismissFound() {
    dismissedFound.add(workspaceId);
    setDismissed(true);
  }

  const othersDialog = (
    <OtherMachinesDialog
      open={othersOpen}
      onOpenChange={setOthersOpen}
      workspace={current.workspace.name}
      others={others}
      onAdded={() => router.invalidate()}
    />
  );

  const dialog = (
    <GithubRunnersDialog
      open={githubOpen}
      onOpenChange={setGithubOpen}
      hasAccounts={current.installations.length > 0}
      initial={found}
      onLoaded={keepFound}
      onAdded={async () => {
        await router.invalidate();
        await findRunners();
      }}
    />
  );

  const empty = machinesLoaded !== null && rows.length === 0;
  const showFound = addable.length > 0 && !dismissed;
  // The user hasn't connected a computer with the CLI anywhere yet: the page shows the command.
  const [connectDismissed, setConnectDismissed] = useState(() => readFlag(CONNECT_DISMISSED_KEY));
  const hasOwnMachine =
    others.length > 0 || allMachines.some((machine) => machine.mine && machine.source !== "github");
  const showConnect = !hasOwnMachine && !connectDismissed;
  function dismissConnect() {
    saveFlag(CONNECT_DISMISSED_KEY, true);
    setConnectDismissed(true);
  }

  return (
    <section>
      {dialog}
      {othersDialog}
      <PageHeader
        title="Runners"
        action={
          !machinesLoaded || (empty && others.length === 0) ? undefined : (
            <AddRunner
              onAddExisting={() => setGithubOpen(true)}
              onAddMine={others.length > 0 ? () => setOthersOpen(true) : undefined}
            />
          )
        }
      >
        Self-hosted and cloud runners for your jobs.{" "}
        <Link to="/settings/agents" className="text-foreground underline underline-offset-2">
          Connect your agent
        </Link>{" "}
        to check on them without opening the dashboard.
      </PageHeader>
      <TooltipProvider>
        <div className="grid max-w-5xl gap-8">
          {!othersDismissed && machinesLoaded && (
            <OtherMachinesBanner
              workspace={current.workspace.name}
              others={others}
              onChoose={() => setOthersOpen(true)}
              onDismiss={dismissOthers}
            />
          )}
          {machinesLoaded && !empty && (
            <RunnersNow
              machines={allMachines}
              live={live}
              updatedAt={updatedAt}
              attention={
                <NeedsAttention
                  items={attention}
                  onAddRunner={editable ? () => setGithubOpen(true) : undefined}
                  onChanged={refreshMachines}
                />
              }
            />
          )}
          {/* Where the counts of running, idle, offline and queued go once the machines are back. */}
          {!machinesLoaded && (
            <div
              aria-busy
              aria-label="Loading"
              className="h-[108px] animate-pulse rounded-xl bg-muted"
            />
          )}
          {!machinesLoaded ? (
            <RunnerGroup title="Self-hosted">
              <CardSkeletons count={3} />
            </RunnerGroup>
          ) : empty ? (
            <RunnerGroup title="Self-hosted" bare>
              <ConnectLanding
                fallback={order ? fallbackAfterMachine(order.order.steps) : null}
                found={editable ? addable : []}
                onAddFound={addFound}
                onAddExisting={editable ? () => setGithubOpen(true) : undefined}
              />
            </RunnerGroup>
          ) : (
            <RunnerGroup
              title="Self-hosted"
              bare={list}
              action={
                <div className="flex items-center gap-1">
                  <RunnerFilterMenu
                    rows={rows}
                    search={search}
                    count={filters}
                    inactiveCount={inactiveCount}
                    onChange={setSearch}
                  />
                  {!list && (
                    <Button
                      variant="ghost"
                      size="xs"
                      aria-pressed={showSpecs}
                      onClick={() => {
                        saveFlag(SHOW_SPECS_KEY, !showSpecs);
                        setShowSpecs(!showSpecs);
                      }}
                    >
                      {showSpecs ? (
                        <ChevronsDownUpIcon aria-hidden />
                      ) : (
                        <ChevronsUpDownIcon aria-hidden />
                      )}
                      {showSpecs ? "Hide specs" : "Show specs"}
                    </Button>
                  )}
                  <ViewToggle
                    list={list}
                    onChange={(next) => {
                      saveFlag(LIST_KEY, next);
                      setList(next);
                    }}
                  />
                </div>
              }
              footer={
                <RunnerFootnote
                  shown={shown.length}
                  total={rows.length}
                  filtered={filters > 0}
                  inactiveHidden={matching.length - shown.length}
                  showingInactive={(search.inactive ?? false) && inactiveCount > 0}
                  onClearFilters={() => setSearch(CLEARED_FILTERS)}
                  onShowInactive={(show) => setSearch({ inactive: show || undefined })}
                />
              }
            >
              {list ? (
                <div className="grid gap-3">
                  <RunnerList
                    rows={shown}
                    jobTimes={jobTimes ?? NO_JOB_TIMES}
                    onRemovedFromWorkspace={dismissOthers}
                  />
                  {showConnect && (
                    <div className="max-w-md">
                      <ConnectCard onDismiss={dismissConnect} />
                    </div>
                  )}
                  {showFound && (
                    <p className="text-sm text-muted-foreground">
                      {addable.length} more {addable.length === 1 ? "runner is" : "runners are"}{" "}
                      already registered on GitHub.{" "}
                      <button
                        type="button"
                        className="rounded-sm font-semibold text-go outline-none hover:text-go-hover focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={() => setGithubOpen(true)}
                      >
                        Review and add
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                <>
                  {shown.map(({ machine, view }) => (
                    <li key={machine.id} className="grid min-w-0">
                      <MachineCard
                        machine={machine}
                        view={view}
                        jobTime={jobTimes?.[machine.id]}
                        specs={showSpecs}
                        onRemovedFromWorkspace={dismissOthers}
                      />
                    </li>
                  ))}
                  {showConnect && (
                    <li className="grid min-w-0">
                      <ConnectCard onDismiss={dismissConnect} />
                    </li>
                  )}
                  {showFound && (
                    <li className="grid min-w-0">
                      <FoundCard
                        runners={addable}
                        onAdd={addFound}
                        onReview={() => setGithubOpen(true)}
                        onDismiss={dismissFound}
                      />
                    </li>
                  )}
                </>
              )}
            </RunnerGroup>
          )}
          {!cloud && (
            <RunnerGroup title="Cloud-hosted">
              <CardSkeletons count={2} />
            </RunnerGroup>
          )}
          {cloud && (
            <RunnerGroup
              title="Cloud-hosted"
              action={
                <div className="flex items-center gap-1">
                  <TimeRangePicker
                    {...PROVIDER_RANGES}
                    quiet
                    value={cloudRange}
                    onChange={(range) =>
                      setSearch({ cloud: unlessDefault(range, PROVIDER_DEFAULT_RANGE) })
                    }
                  />
                  <ViewToggle
                    list={cloudList}
                    onChange={(next) => {
                      saveFlag(CLOUD_LIST_KEY, next);
                      setCloudList(next);
                    }}
                  />
                </div>
              }
              bare={cloudList || cloud.length === 0}
              footer={
                <p className="text-xs text-muted-foreground">
                  Est. cost is at list prices, before any included minutes. Each provider's page has
                  its plans and prices.
                </p>
              }
            >
              {cloud.length > 0 && cloudList ? (
                <CloudRunnersTable providers={cloud} range={search.cloud} />
              ) : cloud.length > 0 ? (
                cloud.map((summary) => (
                  <li key={summary.provider} className="grid min-w-0">
                    <CloudProviderCard summary={summary} range={search.cloud} />
                  </li>
                ))
              ) : (
                <p className="rounded-xl border border-dashed bg-card px-4 py-6 text-sm text-muted-foreground">
                  No jobs ran in the cloud in {rangePhrase(cloudRange)}.
                </p>
              )}
            </RunnerGroup>
          )}
        </div>
      </TooltipProvider>
    </section>
  );
}

// Card-shaped placeholders while a section's first answer is on its way.
function CardSkeletons({ count }: { count: number }) {
  return Array.from({ length: count }, (_, i) => (
    <li key={i} className="grid min-w-0" aria-hidden>
      <div className="h-44 animate-pulse rounded-xl bg-muted" />
    </li>
  ));
}

function RunnerGroup({
  title,
  action,
  bare = false,
  footer,
  children,
}: {
  title: string;
  /** A control at the end of the heading. */
  action?: ReactNode;
  /** A line under the group, such as what's hidden. */
  footer?: ReactNode;
  /** Children laid out as they are, not as a grid of cards. */
  bare?: boolean;
  children: ReactNode;
}) {
  const id = `group-${title.toLowerCase()}`;
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 id={id} className="flex items-baseline gap-2 text-sm font-semibold">
          {title}
        </h2>
        {action}
      </div>
      <SectionBoundary>
        {bare ? (
          children
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,19rem),1fr))] gap-3">
            {children}
          </ul>
        )}
      </SectionBoundary>
      {footer}
    </section>
  );
}

// Cards or a list, as two icon buttons.
function ViewToggle({ list, onChange }: { list: boolean; onChange: (list: boolean) => void }) {
  const options = [
    { list: false, label: "Cards", icon: <LayoutGridIcon aria-hidden /> },
    { list: true, label: "List", icon: <ListIcon aria-hidden /> },
  ];
  return (
    <div role="group" aria-label="View" className="flex items-center">
      {options.map((option) => (
        <Tooltip key={option.label}>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={option.label}
              aria-pressed={list === option.list}
              className={cn(list === option.list ? "text-foreground" : "text-muted-foreground")}
              onClick={() => onChange(option.list)}
            >
              {option.icon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{option.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

// Narrows the self-hosted runners by status, owner and whose jobs they take. Each section lists
// only what the runners have, plus anything already picked.
function RunnerFilterMenu({
  rows,
  search,
  count,
  inactiveCount,
  onChange,
}: {
  rows: RunnerRow[];
  search: RunnerSearch;
  count: number;
  inactiveCount: number;
  onChange: (next: Partial<RunnerSearch>) => void;
}) {
  const statuses = splitFilter(search.status);
  const owners = splitFilter(search.owner);
  const tones = new Set<string>([...rows.map((row) => row.view.tone), ...statuses]);
  const ownerOptions = [...new Set([...rows.map((row) => row.owner), ...owners])].sort(
    (a, b) => Number(b === "You") - Number(a === "You") || a.localeCompare(b),
  );
  const toggle = (values: string[], value: string, on: boolean) =>
    joinFilter(on ? [...values, value] : values.filter((v) => v !== value));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className={cn(count > 0 && "text-foreground")}>
          <ListFilterIcon aria-hidden className={cn(count > 0 && "text-go")} />
          {count > 0 ? `Filtered by ${count}` : "Filter"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <FilterSection label="Status">
          {STATUSES.filter((status) => tones.has(status.value)).map((status) => (
            <FilterItem
              key={status.value}
              checked={statuses.includes(status.value)}
              onChange={(on) => onChange({ status: toggle(statuses, status.value, on) })}
            >
              {status.label}
            </FilterItem>
          ))}
        </FilterSection>
        {ownerOptions.length > 1 && (
          <FilterSection label="Owner">
            {ownerOptions.map((owner) => (
              <FilterItem
                key={owner}
                checked={owners.includes(owner)}
                onChange={(on) => onChange({ owner: toggle(owners, owner, on) })}
              >
                <span className="truncate">{owner}</span>
              </FilterItem>
            ))}
          </FilterSection>
        )}
        <FilterSection label="Runs">
          {(["anyone", "only_me"] as const).map((value) => (
            <FilterItem
              key={value}
              checked={search.runs === value}
              onChange={(on) => onChange({ runs: on ? value : undefined })}
            >
              {value === "anyone" ? sharingLabel("anyone", false) : "Only its owner's jobs"}
            </FilterItem>
          ))}
        </FilterSection>
        {inactiveCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <FilterItem
              checked={search.inactive ?? false}
              onChange={(on) => onChange({ inactive: on || undefined })}
            >
              Show inactive runners
            </FilterItem>
          </>
        )}
        {count > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(CLEARED_FILTERS)}>
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// A labeled group of checkboxes, with a separator above all but the first.
function FilterSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      {label !== "Status" && <DropdownMenuSeparator />}
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
        {label}
      </DropdownMenuLabel>
      {children}
    </>
  );
}

// A checkbox that leaves the menu open, so several can be picked in a row.
function FilterItem({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (on: boolean) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenuCheckboxItem
      checked={checked}
      onSelect={(event) => event.preventDefault()}
      onCheckedChange={(on) => onChange(on === true)}
    >
      {children}
    </DropdownMenuCheckboxItem>
  );
}

// What the filters and the inactive rule are hiding, with a way back to everything.
function RunnerFootnote({
  shown,
  total,
  filtered,
  inactiveHidden,
  showingInactive,
  onClearFilters,
  onShowInactive,
}: {
  shown: number;
  total: number;
  filtered: boolean;
  inactiveHidden: number;
  showingInactive: boolean;
  onClearFilters: () => void;
  onShowInactive: (show: boolean) => void;
}) {
  if (!filtered && inactiveHidden === 0 && !showingInactive) return null;
  const link =
    "rounded-sm font-medium text-ink-2 underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50";
  const inactive = plural(inactiveHidden, "runner");
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-muted-foreground">
      {filtered && (
        <span>
          {shown === 0 ? "No runners match these filters." : `Showing ${shown} of ${total}.`}{" "}
          <button type="button" className={link} onClick={onClearFilters}>
            Clear filters
          </button>
        </span>
      )}
      {inactiveHidden > 0 && (
        <span>
          {inactive} inactive for over {INACTIVE_DAYS} days {inactiveHidden === 1 ? "is" : "are"}{" "}
          hidden.{" "}
          <button type="button" className={link} onClick={() => onShowInactive(true)}>
            Show
          </button>
        </span>
      )}
      {showingInactive && (
        <button type="button" className={link} onClick={() => onShowInactive(false)}>
          Hide runners inactive for over {INACTIVE_DAYS} days
        </button>
      )}
    </p>
  );
}

// Where a job goes when no self-hosted runner can take it: the first step after self-hosted.
function fallbackAfterMachine(steps: RunnerStep[]): RunnerKey | null {
  const at = steps.findIndex((step) => step.key === "machine");
  return steps.slice(at + 1).find((step) => step.key !== "machine")?.key ?? null;
}

// No self-hosted runners yet: the section says what connecting does, then hands over the one command.
function ConnectLanding({
  fallback,
  found,
  onAddFound,
  onAddExisting,
}: {
  fallback: RunnerKey | null;
  /** Runners already on GitHub that could be added. */
  found: AddableRunner[];
  onAddFound: (runner: AddableRunner) => Promise<void>;
  /** Missing for members, who can't add runners from GitHub. */
  onAddExisting?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(CONNECT_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the command is still there to select.
    }
  }
  const elsewhere =
    fallback === "github"
      ? {
          icon: <GithubIcon className="size-5" />,
          name: "GitHub-hosted",
          when: "when it's closed, asleep or busy",
        }
      : fallback
        ? {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: RUNNER_LABELS[fallback],
            when: "when it's closed, asleep or busy",
          }
        : {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: "Nowhere",
            when: "jobs that need it stop early",
          };

  return (
    <div className="grid gap-10 rounded-xl border border-dashed px-5 py-8 sm:px-10 sm:py-12">
      <figure
        aria-label="Where a private repo job runs"
        className="m-0 grid w-fit gap-4 justify-self-center sm:flex sm:items-center sm:gap-0"
      >
        <span className="flex items-center gap-2 justify-self-start rounded-full border bg-card px-4 py-2.5 text-sm whitespace-nowrap text-ink-2">
          <CirclePlayIcon aria-hidden className="size-[18px]" />
          Private repo job
        </span>
        {/* Wide screens: the job forks to the right. */}
        <svg
          aria-hidden
          viewBox="0 0 110 190"
          className="hidden h-[190px] w-[110px] shrink-0 sm:block"
        >
          <path d="M0 95 C55 95 55 38 110 38" fill="none" className="stroke-go" strokeWidth="2" />
          <path
            d="M0 95 C55 95 55 152 110 152"
            fill="none"
            className="stroke-idle"
            strokeWidth="2"
            strokeDasharray="4 5"
          />
        </svg>
        <div className="relative grid gap-4 pl-11 sm:gap-16 sm:pl-0">
          {/* Phones: the job drops down from the pill, to the laptop first and then on down. */}
          <span
            aria-hidden
            className="absolute top-[-16px] bottom-[22px] left-[24px] w-5 rounded-bl-lg border-b-2 border-l-2 border-dashed border-idle sm:hidden"
          />
          <div className="relative">
            <span
              aria-hidden
              className="absolute top-[-16px] bottom-1/2 left-[-20px] w-5 rounded-bl-lg border-b-2 border-l-2 border-go sm:hidden"
            />
            <RouteEnd
              on
              icon={<LaptopIcon aria-hidden className="size-5" />}
              name="Your laptop"
              when={<>while it's connected</>}
            />
          </div>
          <RouteEnd icon={elsewhere.icon} name={elsewhere.name} when={elsewhere.when} />
        </div>
      </figure>

      <div className="grid justify-items-center gap-3">
        {ON_MAC && (
          <>
            <MacAppButton size="default" />
            <p className="text-center text-sm text-muted-foreground">Or run this in a terminal:</p>
          </>
        )}
        <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-md border bg-card py-2 pr-2 pl-4 font-mono text-sm">
          <span className="truncate">
            <span aria-hidden className="text-muted-foreground select-none">
              ${" "}
            </span>
            {CONNECT_COMMAND}
          </span>
          <Button size="sm" className="font-sans" onClick={() => void copy()}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {!ON_MAC && (
          <p className="text-center text-sm text-muted-foreground">
            Run it in a terminal on the computer you want CI on. On a Mac? <MacAppLink />
          </p>
        )}
        {onAddExisting && found.length > 0 && (
          <div className="mt-3 grid w-full max-w-md gap-1">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <GithubIcon className="size-4" />
              Or add {found.length === 1 ? "the runner" : `the ${found.length} runners`} already on
              GitHub
            </p>
            <FoundRunnerRows runners={found} onAdd={onAddFound} />
            {found.length > FOUND_PREVIEW && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={onAddExisting}
              >
                See all {found.length}
              </Button>
            )}
          </div>
        )}
        {onAddExisting && found.length === 0 && (
          <Button variant="ghost" size="sm" className="mt-1" onClick={onAddExisting}>
            <GithubIcon />
            Already have a self-hosted runner? Add it
          </Button>
        )}
      </div>
    </div>
  );
}

// Beside other runners, for a user who hasn't connected a computer yet: the landing's command, small.
function ConnectCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <article
      aria-label="Connect your computer"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-dashed"
    >
      <div className="grid min-w-0 gap-2.5 px-4 pt-3 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
            <LaptopIcon aria-hidden className="size-3.5" />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">Run jobs on your computer</h3>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 -mr-2 shrink-0 text-muted-foreground"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        {ON_MAC && <MacAppButton />}
        <CopyCommand command={CONNECT_COMMAND} />
        <p className="text-xs text-muted-foreground">
          {ON_MAC ? "Or run the command in a terminal. " : "Run it in a terminal. "}
          Your computer takes jobs while it's connected.
          {!ON_MAC && (
            <>
              {" "}
              On a Mac? <MacAppLink />
            </>
          )}
        </p>
      </div>
      <div className="mt-auto flex min-h-10 items-center border-t border-dashed px-4 py-2 text-xs">
        <a
          href={`${DOCS_URL}/get-started/quickstart`}
          target="_blank"
          rel="noreferrer"
          className="-mx-1 rounded-sm px-1 font-semibold text-go outline-none hover:text-go-hover focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          See the quickstart
        </a>
      </div>
    </article>
  );
}

// One end of the route diagram: where the job lands, and when.
function RouteEnd({
  on = false,
  icon,
  name,
  when,
}: {
  on?: boolean;
  icon: ReactNode;
  name: string;
  when: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-[10px] border",
          on ? "border-go-edge bg-go-soft text-go" : "bg-card text-ink-2",
        )}
      >
        {icon}
      </span>
      <span className="grid">
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-sm text-muted-foreground">{when}</span>
      </span>
    </div>
  );
}
