import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import {
  getActivity,
  getActivityOptions,
  type ActivityItem,
  type ActivityOptions,
  type ActivityPage,
} from "@/lib/activity";
import { authDisabled } from "@/lib/auth-client";
import { useLiveRefresh } from "@/lib/live-refresh";
import { getCheckSavings, type FreeCheckSavings } from "@/lib/usage";
import {
  type ActivitySearch,
  oneOf,
  TYPES,
  appliesTo,
  RANGES,
  text,
  RESULTS,
  toQuery,
  CLEARED,
} from "@/features/activity/search";
import {
  SavingsLink,
  LOG_GRID,
  JobRow,
  UnroutableRow,
  CheckRow,
  RetryRow,
  EventRow,
} from "@/features/activity/rows";
import { Filters } from "@/features/activity/filters";

// Fast enough that a push shows up within seconds, without a live connection.
const POLL_MS = 5_000;

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
  loader: ({ deps }): Promise<ActivityPage> => getActivity(toQuery(deps)),
  component: ActivityRoute,
});

function ActivityRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [savings, setSavings] = useState<FreeCheckSavings | null>(null);
  const [options, setOptions] = useState<ActivityOptions>({ repositories: [], machines: [] });

  useEffect(() => {
    // The log works without either.
    getCheckSavings("30d")
      .then(setSavings)
      .catch(() => undefined);
    getActivityOptions()
      .then(setOptions)
      .catch(() => undefined);
  }, []);

  const update = (patch: ActivitySearch) =>
    void navigate({ search: (prev) => ({ ...prev, ...patch }), resetScroll: false });
  const narrowed = Boolean(search.days || search.repo || search.result || search.machine);

  return (
    <section>
      <PageHeader
        className="max-w-6xl"
        title="Activity"
        action={savings && savings.checks > 0 && <SavingsLink savings={savings} />}
      >
        Routed jobs, optimized checks, machine events and member changes, newest first.
      </PageHeader>
      <div className="grid max-w-6xl gap-3">
        <Filters search={search} options={options} narrowed={narrowed} onChange={update} />
        <SectionBoundary>
          <Log search={search} narrowed={narrowed} onClear={() => update(CLEARED)} />
        </SectionBoundary>
      </div>
    </section>
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
              Nothing yet. Turn on an optimized check with{" "}
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
        <ul className={LOG_GRID}>
          {items.map((item) =>
            item.job ? (
              <JobRow key={item.id} job={item.job} now={now} />
            ) : item.type === "job.unroutable" ? (
              <UnroutableRow key={item.id} item={item} now={now} />
            ) : item.type === "check.completed" ? (
              <CheckRow key={item.id} item={item} now={now} />
            ) : item.type === "job.retried" ? (
              <RetryRow key={item.id} item={item} now={now} />
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
