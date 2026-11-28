import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { AddRunner, GithubRunnersDialog } from "@/components/add-runner";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { OtherMachinesBanner, OtherMachinesDialog } from "@/components/other-machines";
import { FoundCard, MachineCard, machineView } from "@/components/runner-card";
import { CloudProviderCard } from "@/components/cloud-runners";
import { CloudRunnersTable } from "@/components/cloud-runners-table";
import { TimeRangePicker } from "@/components/range-picker";
import { RunnerList, type RunnerRow } from "@/components/runner-list";
import { NeedsAttention } from "@/components/runner-attention";
import { RunnersFreshness, RunnersNow } from "@/components/runners-now";
import { Button } from "@/components/ui/button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { attentionItems } from "@/lib/attention";
import { authDisabled } from "@/lib/auth-client";
import { type Stat } from "@/lib/job-times";
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
import { isPersonal } from "@/lib/personal-runner";
import { PROVIDER_DEFAULT_RANGE, PROVIDER_RANGES, type ProviderSummary } from "@/lib/providers";
import { canManage } from "@/lib/roles";
import {
  CLEARED_FILTERS,
  filterCount,
  INACTIVE_DAYS,
  isInactive,
  matchesFilters,
  ownerOf,
  type RunnerSearch,
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
import {
  RunnerGroup,
  CardSkeletons,
  ViewToggle,
  RunnerFootnote,
} from "@/features/runners/runner-group";
import { ConnectLanding, fallbackAfterMachine, ConnectCard } from "@/features/runners/connect";
import { RunnerFilterMenu } from "@/features/runners/filter-menu";

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

// Whether personal and shared runners show as a list instead of cards, kept per browser.
const LIST_KEY = "relayrunner:runners:list";

// Cloud-hosted as one table rather than a card per provider.
const CLOUD_LIST_KEY = "relayrunner:runners:cloud-list";

// Whether the user closed the card that shows how to connect their own computer, kept per browser.
const CONNECT_DISMISSED_KEY = "relayrunner:runners:connect-dismissed";

// Whether personal and shared runner cards show their hardware and typical job, kept per browser.
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

// The runners the workspace supplies, grouped as Personal and Shared. Where jobs go is the Router's job;
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
  // Personal and shared runners narrowed by the filter menu, kept in the URL. Runners that have been
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

  // Personal runners take only their owner's jobs (yours first); shared ones take any job routed
  // to them. A section shows while the workspace has any of its kind, even when filters hide them.
  const { hasPersonal, hasShared, personal, shared } = useMemo(() => {
    const personal: RunnerRow[] = [];
    const shared: RunnerRow[] = [];
    for (const row of shown) (isPersonal(row.machine) ? personal : shared).push(row);
    personal.sort((a, b) => Number(!!b.machine.mine) - Number(!!a.machine.mine));
    const kinds = new Set(rows.map((row) => isPersonal(row.machine)));
    return { hasPersonal: kinds.has(true), hasShared: kinds.has(false), personal, shared };
  }, [rows, shown]);
  const showPersonal = hasPersonal || showConnect;
  const showShared = hasShared || showFound;
  const controls = (
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
          {showSpecs ? <ChevronsDownUpIcon aria-hidden /> : <ChevronsUpDownIcon aria-hidden />}
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
  );
  const footnote = (
    <RunnerFootnote
      shown={shown.length}
      total={rows.length}
      filtered={filters > 0}
      inactiveHidden={matching.length - shown.length}
      showingInactive={(search.inactive ?? false) && inactiveCount > 0}
      onClearFilters={() => setSearch(CLEARED_FILTERS)}
      onShowInactive={(show) => setSearch({ inactive: show || undefined })}
    />
  );
  // One section's runners as cards or a list, then its extra card (connect, or found on GitHub).
  function section(sectionRows: RunnerRow[], extra: ReactNode) {
    if (list) {
      return (
        <div className="grid gap-3">
          {sectionRows.length > 0 && (
            <SectionBoundary>
              <RunnerList
                rows={sectionRows}
                jobTimes={jobTimes ?? NO_JOB_TIMES}
                onRemovedFromWorkspace={dismissOthers}
              />
            </SectionBoundary>
          )}
          {extra && <div className="max-w-md">{extra}</div>}
        </div>
      );
    }
    return (
      <>
        {sectionRows.map(({ machine, view }) => (
          <li key={machine.id} className="grid min-w-0">
            <SectionBoundary>
              <MachineCard
                machine={machine}
                view={view}
                jobTime={jobTimes?.[machine.id]}
                specs={showSpecs}
                onRemovedFromWorkspace={dismissOthers}
              />
            </SectionBoundary>
          </li>
        ))}
        {extra && (
          <li className="grid min-w-0">
            <SectionBoundary>{extra}</SectionBoundary>
          </li>
        )}
      </>
    );
  }

  return (
    <section>
      {dialog}
      {othersDialog}
      <PageHeader
        className="max-w-5xl"
        title="Runners"
        action={
          !machinesLoaded || (empty && others.length === 0) ? undefined : (
            <div className="flex items-center gap-4">
              {!empty && <RunnersFreshness machines={allMachines} updatedAt={updatedAt} />}
              <AddRunner
                onAddExisting={() => setGithubOpen(true)}
                onAddMine={others.length > 0 ? () => setOthersOpen(true) : undefined}
              />
            </div>
          )
        }
      >
        Personal, shared and cloud runners for your jobs.{" "}
        <Link to="/settings/agents" className="text-foreground underline underline-offset-2">
          Connect your agent
        </Link>{" "}
        to check on them without opening the dashboard.
      </PageHeader>
      <TooltipProvider>
        <div className="grid max-w-5xl gap-8">
          <SectionBoundary>
            {!othersDismissed && machinesLoaded && (
              <OtherMachinesBanner
                workspace={current.workspace.name}
                others={others}
                onChoose={() => setOthersOpen(true)}
                onDismiss={dismissOthers}
              />
            )}
          </SectionBoundary>
          <SectionBoundary>
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
          </SectionBoundary>
          {/* Where the counts of running, idle, offline and queued go once the machines are back. */}
          {!machinesLoaded && (
            <div
              aria-busy
              aria-label="Loading"
              className="h-[108px] animate-pulse rounded-xl bg-muted"
            />
          )}
          {!machinesLoaded ? (
            <RunnerGroup title="Personal runners">
              <CardSkeletons count={3} />
            </RunnerGroup>
          ) : empty ? (
            <RunnerGroup title="Personal runners" bare>
              <SectionBoundary>
                <ConnectLanding
                  fallback={order ? fallbackAfterMachine(order.order.steps) : null}
                  found={editable ? addable : []}
                  onAddFound={addFound}
                  onAddExisting={editable ? () => setGithubOpen(true) : undefined}
                />
              </SectionBoundary>
            </RunnerGroup>
          ) : (
            <>
              {/* The filter, specs and view controls sit on the first section; the footnote on the last. */}
              {showPersonal && (
                <RunnerGroup
                  title="Personal runners"
                  bare={list || (personal.length === 0 && !showConnect)}
                  action={controls}
                  footer={showShared ? undefined : footnote}
                >
                  {personal.length === 0 && !showConnect ? (
                    <p className="text-sm text-muted-foreground">No personal runners match.</p>
                  ) : (
                    section(personal, showConnect && <ConnectCard onDismiss={dismissConnect} />)
                  )}
                </RunnerGroup>
              )}
              {showShared && (
                <RunnerGroup
                  title="Shared runners"
                  bare={list || (shared.length === 0 && !showFound)}
                  action={showPersonal ? undefined : controls}
                  footer={footnote}
                >
                  {shared.length === 0 && !showFound ? (
                    <p className="text-sm text-muted-foreground">No shared runners match.</p>
                  ) : (
                    section(
                      shared,
                      showFound && (
                        <FoundCard
                          runners={addable}
                          onAdd={addFound}
                          onReview={() => setGithubOpen(true)}
                          onDismiss={dismissFound}
                        />
                      ),
                    )
                  )}
                </RunnerGroup>
              )}
            </>
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
                <SectionBoundary>
                  <CloudRunnersTable providers={cloud} range={search.cloud} />
                </SectionBoundary>
              ) : cloud.length > 0 ? (
                cloud.map((summary) => (
                  <li key={summary.provider} className="grid min-w-0">
                    <SectionBoundary>
                      <CloudProviderCard summary={summary} range={search.cloud} />
                    </SectionBoundary>
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
