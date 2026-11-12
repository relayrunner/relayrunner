import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createCellContext, DataTable, dataTableColumns } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/activity";
import {
  discardDeadLetter,
  listDeadLetters,
  replayDeadLetter,
  replayMatching,
  type DeadLetter,
  type DeadLetterPage,
} from "@/lib/dead-letters";

// Operator admin, behind Cloudflare Access (the dashboard Worker and the API both check the
// Access JWT, and answer 403 or 404 everywhere else). Previews share the production API, so
// Replay here acts on production.
export const Route = createFileRoute("/_authed/_workspace/admin/webhooks")({
  loader: (): Promise<DeadLetterPage> => listDeadLetters(),
  component: DeadLettersPage,
});

function DeadLettersPage() {
  const first = Route.useLoaderData();
  const [letters, setLetters] = useState(first.deadLetters);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [event, setEvent] = useState("");
  const [repository, setRepository] = useState("");

  const filter = { event: event.trim() || undefined, repository: repository.trim() || undefined };
  const shown = useMemo(
    () =>
      letters.filter(
        (letter) =>
          (!filter.event || letter.event === filter.event) &&
          (!filter.repository ||
            letter.repository?.toLowerCase() === filter.repository.toLowerCase()),
      ),
    [letters, filter.event, filter.repository],
  );

  async function act(id: string, run: () => Promise<unknown>, done: string) {
    setBusy(id);
    setNotice(null);
    try {
      await run();
      setLetters((all) => all.filter((letter) => letter.id !== id));
      setNotice(done);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  function replay(letter: DeadLetter) {
    void act(letter.id, () => replayDeadLetter(letter.id), `Replayed ${letter.deliveryId}.`);
  }

  function discard(letter: DeadLetter) {
    if (!confirm(`Discard ${letter.deliveryId}? It can't be replayed after this.`)) return;
    void act(letter.id, () => discardDeadLetter(letter.id), `Discarded ${letter.deliveryId}.`);
  }

  async function replayFiltered() {
    if (!filter.event && !filter.repository) return;
    setBusy("bulk");
    setNotice(null);
    try {
      const { replayed, more } = await replayMatching(filter);
      const gone = new Set(replayed);
      setLetters((all) => all.filter((letter) => !gone.has(letter.id)));
      setNotice(
        `Replayed ${replayed.length} dead letter${replayed.length === 1 ? "" : "s"}.${more ? " More match: replay again for the next batch." : ""}`,
      );
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadOlder() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await listDeadLetters(cursor);
      setLetters((all) => [...all, ...page.deadLetters]);
      setCursor(page.nextCursor);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="Webhook dead letters">
        GitHub deliveries that failed every retry, newest first. Fix the cause, then replay them:
        Replay sends the original message, with its delivery ID, back through the queue and
        consumer. This acts on production. Dead letters are kept for 30 days.
      </PageHeader>

      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Event</span>
          <Input
            value={event}
            onChange={(e) => setEvent(e.target.value)}
            placeholder="workflow_job"
            className="w-44"
          />
        </label>
        <label className="grid gap-1 text-sm">
          <span className="text-muted-foreground">Repository</span>
          <Input
            value={repository}
            onChange={(e) => setRepository(e.target.value)}
            placeholder="owner/repo"
            className="w-56"
          />
        </label>
        <Button
          variant="outline"
          disabled={(!filter.event && !filter.repository) || busy !== null}
          onClick={() => void replayFiltered()}
        >
          <RotateCcw />
          {busy === "bulk" ? "Replaying…" : "Replay all matching"}
        </Button>
      </div>

      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}

      {shown.length === 0 ? (
        <p className="rounded-xl border bg-card px-4 py-6 text-sm text-muted-foreground">
          {letters.length === 0
            ? "No dead letters. Every webhook delivery in the past 30 days was processed."
            : "No dead letters match that filter."}
        </p>
      ) : (
        <LetterActions value={{ busy: busy !== null, replay, discard }}>
          <DataTable
            columns={columns}
            data={shown}
            getRowId={(letter) => letter.id}
            initialSorting={[{ id: "deadLetteredAt", desc: true }]}
          />
        </LetterActions>
      )}

      {cursor && (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          disabled={loading}
          onClick={() => void loadOlder()}
        >
          {loading ? "Loading…" : "Show older"}
        </Button>
      )}
    </section>
  );
}

const [LetterActions, useLetterActions] = createCellContext<{
  busy: boolean;
  replay: (letter: DeadLetter) => void;
  discard: (letter: DeadLetter) => void;
}>("Dead letters");

const TOP = { className: "py-3 align-top" };

const column = dataTableColumns<DeadLetter>();
const columns = column.columns([
  column.accessor("deadLetteredAt", {
    header: "Dead-lettered",
    sortFn: "text",
    sortDescFirst: true,
    meta: { className: "py-3 align-top whitespace-nowrap" },
    cell: ({ getValue }) => <span title={getValue()}>{timeAgo(getValue(), Date.now())}</span>,
  }),
  column.accessor("event", {
    header: "Event",
    sortFn: "text",
    meta: TOP,
    cell: ({ row: { original: letter } }) => (
      <>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono">{letter.event}</span>
          {letter.action && <Badge variant="idle">{letter.action}</Badge>}
        </div>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{letter.deliveryId}</div>
      </>
    ),
  }),
  column.accessor((letter) => letter.repository ?? undefined, {
    id: "repository",
    header: "Repository",
    sortFn: "text",
    meta: TOP,
    cell: ({ getValue }) => getValue() ?? "—",
  }),
  column.accessor("attempts", {
    header: "Attempts",
    sortFn: "basic",
    sortDescFirst: true,
    meta: { align: "end", className: "py-3 align-top" },
  }),
  column.accessor((letter) => letter.lastError ?? "—", {
    id: "lastError",
    header: "Last error",
    enableSorting: false,
    meta: { className: "max-w-xs py-3 align-top text-xs break-words text-muted-foreground" },
  }),
  column.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: TOP,
    cell: ({ row }) => <Actions letter={row.original} />,
  }),
]);

function Actions({ letter }: { letter: DeadLetter }) {
  const { busy, replay, discard } = useLetterActions();
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => replay(letter)}>
        <RotateCcw />
        Replay
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Discard"
        disabled={busy}
        onClick={() => discard(letter)}
      >
        <Trash2 />
      </Button>
    </div>
  );
}
