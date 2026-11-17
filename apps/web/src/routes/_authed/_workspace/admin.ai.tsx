import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { Count } from "@/components/count";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { createCellContext, DataTable, dataTableColumns, NUM } from "@/components/ui/data-table";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WorkspaceMark } from "@/components/workspace-menu";
import { errorText } from "@/lib/api";
import { formatDate } from "@/lib/time-zone";
import { money } from "@/lib/usage";
import {
  type AiAdmin,
  type AiResult,
  type AiSettings,
  getAi,
  saveAi,
  saveWorkspaceAi,
  testAi,
} from "@/lib/admin";

// Operator admin, behind Cloudflare Access and an operator session (apps/api/src/routes/admin-ai.ts).
export const Route = createFileRoute("/_authed/_workspace/admin/ai")({
  loader: () => getAi(),
  component: AiPage,
});

type Notice = { ok: boolean; text: string } | null;
type Row = AiAdmin["workspaces"][number];

const REASONS: Record<Extract<AiResult, { ok: false }>["reason"], string> = {
  off: "AI is off for this workspace or feature.",
  budget: "This workspace is past its daily token budget.",
  rate_limited: "Too many calls this minute.",
  failed: "The model call failed. Workers Logs has the error.",
};

const checkbox = "size-4 accent-[var(--color-go)]";

function AiPage() {
  const data = Route.useLoaderData();
  const [settings, setSettings] = useState<AiSettings>(data.settings);
  const [workspaces, setWorkspaces] = useState(data.workspaces);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);

  async function save(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setNotice(null);
    try {
      await saveAi(settings);
      setNotice({ ok: true, text: "Saved. Other servers pick this up within a minute." });
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    } finally {
      setPending(false);
    }
  }

  async function toggle(row: Row, enabled: boolean) {
    setNotice(null);
    try {
      const { setting } = await saveWorkspaceAi(row.id, {
        enabled,
        features: row.setting?.features ?? null,
        dailyTokens: row.setting?.dailyTokens ?? null,
      });
      setWorkspaces((all) => all.map((w) => (w.id === row.id ? { ...w, setting } : w)));
    } catch (error) {
      setNotice({ ok: false, text: errorText(error) });
    }
  }

  const toggleFeature = (id: string, on: boolean) =>
    setSettings((s) => ({
      ...s,
      features: on ? [...s.features, id] : s.features.filter((f) => f !== id),
    }));
  const tokens = (key: "workspaceDailyTokens" | "dailyTokens") => (
    <Input
      type="number"
      min={0}
      step={1000}
      value={settings[key]}
      onChange={(e) => setSettings((s) => ({ ...s, [key]: Math.max(0, Number(e.target.value)) }))}
    />
  );
  const turnedOff = workspaces.filter((w) => w.offAt).length;

  return (
    <section className="grid max-w-5xl gap-6">
      <PageHeader title="AI">
        Model calls that classify jobs and failures. Every workspace gets them once AI is on here,
        unless an owner or admin turns it off under Settings › General. Every call goes through the{" "}
        {data.gateway} gateway.
      </PageHeader>

      {!data.binding && (
        <p className="text-sm text-destructive">
          The API Worker has no Workers AI binding, so every call is off.
        </p>
      )}

      <Card>
        <CardContent>
          <form onSubmit={save} className="grid gap-5 text-sm">
            <label className="flex cursor-pointer items-center gap-2 font-medium">
              <input
                type="checkbox"
                className={checkbox}
                checked={settings.enabled}
                onChange={(e) => setSettings((s) => ({ ...s, enabled: e.target.checked }))}
              />
              Allow AI calls
            </label>

            <fieldset className="grid gap-2">
              <legend className="mb-2 text-muted-foreground">Features</legend>
              {data.features.map((feature) => (
                <label key={feature.id} className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    className={checkbox}
                    checked={settings.features.includes(feature.id)}
                    onChange={(e) => toggleFeature(feature.id, e.target.checked)}
                  />
                  {feature.label}
                </label>
              ))}
            </fieldset>

            <div className="flex flex-wrap gap-4">
              <Field
                label="Tokens a day per workspace"
                hint={cost(settings.workspaceDailyTokens)}
                className="w-56"
              >
                {tokens("workspaceDailyTokens")}
              </Field>
              <Field
                label="Tokens a day for all workspaces"
                hint={cost(settings.dailyTokens)}
                className="w-56"
              >
                {tokens("dailyTokens")}
              </Field>
            </div>

            <div>
              <Button type="submit" disabled={pending}>
                Save
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">Model: {data.model}</p>
          </form>
        </CardContent>
      </Card>

      {notice && (
        <p
          role="status"
          className={notice.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}
        >
          {notice.text}
        </p>
      )}

      <TestCall workspaces={workspaces} />

      <div className="grid gap-2">
        <h2 className="font-medium">Workspaces</h2>
        <p className="text-sm text-muted-foreground">
          {turnedOff} of {workspaces.length} turned it off. Clear Allowed to block one. Usage covers
          the last {data.usageDays} days.
        </p>
      </div>
      <WorkspaceActions value={{ toggle, settings }}>
        <DataTable
          columns={columns}
          data={workspaces}
          getRowId={(row) => row.id}
          initialSorting={[{ id: "calls", desc: true }]}
          empty="No workspaces yet."
        />
      </WorkspaceActions>
    </section>
  );
}

// Clef-flash's input price; output tokens are free.
const USD_PER_TOKEN = 0.038 / 1_000_000;
const cost = (tokens: number) => `About ${money(tokens * USD_PER_TOKEN)} a day`;

function TestCall({ workspaces }: { workspaces: Row[] }) {
  const [workspaceId, setWorkspaceId] = useState(
    () => workspaces.find((w) => !w.offAt)?.id ?? workspaces[0]?.id ?? "",
  );
  const [text, setText] = useState("The lint job failed: 3 files need formatting.");
  const [result, setResult] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setResult(null);
    try {
      const { result, ms } = await testAi(workspaceId, text);
      setResult(
        result.ok ? `${JSON.stringify(result.answers)} in ${ms} ms` : REASONS[result.reason],
      );
    } catch (error) {
      setResult(errorText(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardContent>
        <form onSubmit={run} className="grid gap-4 text-sm">
          <div>
            <h2 className="font-medium">Test call</h2>
            <p className="text-muted-foreground">
              Asks the model whether the text is about CI, as the workspace, with every check
              applied. It needs AI and the Test feature on, and the workspace not turned off.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Workspace" className="w-56">
              <Select value={workspaceId} onValueChange={setWorkspaceId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workspaces.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Text" className="min-w-0 flex-1 basis-64">
              <Input value={text} maxLength={500} onChange={(e) => setText(e.target.value)} />
            </Field>
            <Button
              type="submit"
              variant="outline"
              disabled={pending || !workspaceId || !text.trim()}
            >
              Run
            </Button>
          </div>
          {result && (
            <p role="status" className="font-mono text-xs break-all text-muted-foreground">
              {result}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}

const [WorkspaceActions, useWorkspaceActions] = createCellContext<{
  toggle: (row: Row, enabled: boolean) => void;
  settings: AiSettings;
}>("AI workspaces");

function Toggle({ row }: { row: Row }) {
  const { toggle } = useWorkspaceActions();
  return (
    <input
      type="checkbox"
      aria-label={`Allow AI for ${row.name}`}
      className={checkbox}
      // No operator row allows the workspace.
      checked={row.setting?.enabled ?? true}
      onChange={(e) => toggle(row, e.target.checked)}
    />
  );
}

function TokensToday({ row, value }: { row: Row; value: number }) {
  const { settings } = useWorkspaceActions();
  const limit = row.setting?.dailyTokens ?? settings.workspaceDailyTokens;
  return (
    <span>
      <Count value={value} />
      <span className="text-muted-foreground">
        {" / "}
        <Count value={limit} />
      </span>
    </span>
  );
}

const column = dataTableColumns<Row>();
const usage = (
  id: keyof NonNullable<Row["usage"]>,
  header: string,
  Cell: (props: { row: Row; value: number }) => ReactNode = ({ value }) => <Count value={value} />,
) =>
  column.accessor((row) => row.usage?.[id] ?? 0, {
    id,
    header,
    sortFn: "basic",
    sortDescFirst: true,
    meta: NUM,
    cell: ({ row, getValue }) => <Cell row={row.original} value={getValue()} />,
  });

const columns = column.columns([
  column.display({
    id: "enabled",
    header: "Allowed",
    cell: ({ row }) => <Toggle row={row.original} />,
  }),
  column.accessor((row) => row.offAt ?? "", {
    id: "offAt",
    header: "Turned off",
    sortFn: "text",
    cell: ({ row }) =>
      row.original.offAt ? (
        formatDate(row.original.offAt)
      ) : (
        <span className="text-muted-foreground">No</span>
      ),
  }),
  column.accessor("name", {
    header: "Workspace",
    sortFn: "text",
    cell: ({ row }) => (
      <div className="flex items-center gap-2.5">
        <WorkspaceMark
          name={row.original.name}
          logo={row.original.logo}
          className="size-6 text-xs"
        />
        <span className="font-medium">{row.original.name}</span>
      </div>
    ),
  }),
  usage("calls", "Calls"),
  usage("cacheHits", "Cached"),
  usage("limited", "Limited"),
  usage("failures", "Failed"),
  usage("tokensToday", "Tokens today", TokensToday),
]);
