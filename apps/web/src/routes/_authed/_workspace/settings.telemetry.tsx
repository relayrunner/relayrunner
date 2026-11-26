import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRightIcon, PlusIcon, XIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { ExportStatus } from "@/components/export-status";
import { LogBucketSection } from "@/components/log-bucket";
import { PageHeader } from "@/components/page-header";
import { SignalRow } from "@/components/signal-row";
import { DOCS_URL } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorText } from "@/lib/api";
import { canManage } from "@/lib/roles";
import {
  getLogBucket,
  getTelemetry,
  type LogChoice,
  PRESETS,
  removeTelemetry,
  LOGS_OF,
  saveTelemetry,
  type Telemetry,
  testTelemetry,
} from "@/lib/telemetry";

export const Route = createFileRoute("/_authed/_workspace/settings/telemetry")({
  loader: async () => {
    const [telemetry, bucket] = await Promise.all([getTelemetry(), getLogBucket()]);
    return { telemetry, bucket };
  },
  component: TelemetrySettingsPage,
});

type PresetId = (typeof PRESETS)[number]["id"];
// A header row: a saved one has a hint and may leave its value blank to keep it.
type HeaderRow = { name: string; value: string; hint?: string };

const rowsFrom = (telemetry: Telemetry): HeaderRow[] =>
  telemetry.configured
    ? telemetry.headers.map(({ name, hint }) => ({ name, value: "", hint }))
    : PRESETS[0].headers.map((name) => ({ name, value: "" }));

const presetFor = (telemetry: Telemetry): PresetId =>
  !telemetry.configured
    ? PRESETS[0].id
    : (PRESETS.find((p) => p.endpoint && telemetry.endpoint.startsWith(p.endpoint))?.id ?? "other");

function TelemetrySettingsPage() {
  const { current } = Route.useRouteContext();
  const loaded = Route.useLoaderData();
  const [telemetry, setTelemetry] = useState(loaded.telemetry);
  const [bucket, setBucket] = useState(loaded.bucket);
  const manager = canManage(current.role);

  return (
    <section>
      <PageHeader className="max-w-3xl" title="Telemetry">
        Send traces and job logs to an OpenTelemetry endpoint, and keep job logs in your own bucket.{" "}
        <a
          href={`${DOCS_URL}/dashboard/telemetry`}
          className="inline-flex items-center gap-0.5 text-go hover:text-go-hover"
        >
          What gets sent
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      </PageHeader>
      <div className="grid max-w-3xl gap-8">
        <div className="grid gap-2">
          <h2 className="text-base font-medium">OpenTelemetry endpoint</h2>
          <p className="text-sm text-muted-foreground">
            Honeycomb, Grafana, Axiom or your own Collector. Traces and job logs both go to this
            endpoint, with the same headers.
          </p>
          <Status telemetry={telemetry} />
          {manager ? (
            <ExportForm telemetry={telemetry} onChange={setTelemetry} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {telemetry.configured
                ? `Telemetry goes to ${telemetry.endpoint}. An owner or admin can change this.`
                : "An owner or admin can set up telemetry."}
            </p>
          )}
        </div>
        <LogBucketSection bucket={bucket} onChange={setBucket} manager={manager} />
      </div>
    </section>
  );
}

/** "Sending traces and failed jobs' logs.", or null when neither is on. */
function sending({ enabled, logs }: Pick<Telemetry, "enabled" | "logs">) {
  const parts = [enabled && "traces", logs !== "off" && LOGS_OF[logs]].filter(Boolean);
  return parts.length ? `Sending ${parts.join(" and ")}.` : null;
}

function Status({ telemetry }: { telemetry: Telemetry }) {
  if (!telemetry.configured) return null;
  return (
    <ExportStatus
      status={telemetry}
      on={sending(telemetry)}
      off="Off. Nothing is being sent."
      sent="Last sent"
      waiting="Waiting for the next run."
    />
  );
}

function ExportForm({
  telemetry,
  onChange,
}: {
  telemetry: Telemetry;
  onChange: (telemetry: Telemetry) => void;
}) {
  const [preset, setPreset] = useState<PresetId>(presetFor(telemetry));
  const [endpoint, setEndpoint] = useState(
    telemetry.configured ? telemetry.endpoint : PRESETS[0].endpoint,
  );
  const [headers, setHeaders] = useState(() => rowsFrom(telemetry));
  const [serviceName, setServiceName] = useState(telemetry.serviceName);
  const [enabled, setEnabled] = useState(telemetry.configured ? telemetry.enabled : true);
  const [logs, setLogs] = useState<LogChoice>(telemetry.logs);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const help = PRESETS.find((p) => p.id === preset)?.help;

  function choosePreset(id: PresetId) {
    const next = PRESETS.find((p) => p.id === id)!;
    setPreset(id);
    setEndpoint(next.endpoint);
    // Keep what's typed or saved under a header the preset also uses.
    setHeaders(
      next.headers.map(
        (name) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase()) ?? { name, value: "" },
      ),
    );
  }

  const setHeader = (index: number, row: Partial<HeaderRow>) =>
    setHeaders(headers.map((h, i) => (i === index ? { ...h, ...row } : h)));

  async function run(action: () => Promise<void>) {
    setPending(true);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setNotice({ ok: false, text: errorText(caught) });
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      const saved = await saveTelemetry({
        endpoint,
        headers: headers
          .filter((h) => h.name.trim())
          .map((h) => ({ name: h.name.trim(), ...(h.value.trim() && { value: h.value.trim() }) })),
        serviceName,
        enabled,
        logs,
      });
      onChange(saved);
      setHeaders(rowsFrom(saved));
      setNotice({ ok: true, text: "Saved. Send a test trace to check it works." });
    });
  }

  const test = () =>
    run(async () => {
      const { sent, telemetry: next } = await testTelemetry();
      onChange(next);
      setNotice(
        sent.ok
          ? {
              ok: true,
              text:
                next.logs === "off"
                  ? "Sent a test trace named “RUN RelayRunner test”."
                  : "Sent a test trace named “RUN RelayRunner test” and a log line “RelayRunner test log”.",
            }
          : { ok: false, text: `The endpoint refused it: ${sent.error}` },
      );
    });

  const remove = () => {
    if (!window.confirm("Stop sending telemetry and forget these settings?")) return;
    void run(async () => {
      const removed = await removeTelemetry();
      onChange(removed);
      choosePreset(PRESETS[0].id);
      setServiceName(removed.serviceName);
      setLogs(removed.logs);
    });
  };

  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <form onSubmit={submit} className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Send to">
              <Select value={preset} onValueChange={(id) => choosePreset(id as PresetId)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESETS.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Endpoint" className="min-w-0 flex-1 basis-64">
              <Input
                type="url"
                required
                spellCheck={false}
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://otlp.example.com"
              />
            </Field>
          </div>
          {help && <p className="-mt-2 text-xs text-muted-foreground">{help}</p>}

          <div className="grid gap-2">
            <span>Headers</span>
            {headers.map((header, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Header name"
                  spellCheck={false}
                  className="w-48"
                  value={header.name}
                  onChange={(e) => setHeader(index, { name: e.target.value, hint: undefined })}
                  placeholder="Header name"
                />
                <Input
                  aria-label={`${header.name || "Header"} value`}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 basis-48"
                  value={header.value}
                  onChange={(e) => setHeader(index, { value: e.target.value })}
                  placeholder={header.hint ? `Saved, ending ${header.hint}` : "Value"}
                />
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${header.name || "header"}`}
                  onClick={() => setHeaders(headers.filter((_, i) => i !== index))}
                >
                  <XIcon aria-hidden className="size-4" />
                </Button>
              </div>
            ))}
            <div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setHeaders([...headers, { name: "", value: "" }])}
              >
                <PlusIcon aria-hidden className="size-4" />
                Add header
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Values are stored encrypted and never shown again. Leave a saved one blank to keep it.
            </p>
          </div>

          <Field
            label="Service name"
            hint="The service name your tool shows for these traces and logs."
            className="max-w-xs"
          >
            <Input
              spellCheck={false}
              value={serviceName}
              onChange={(e) => setServiceName(e.target.value)}
              placeholder="github-actions"
            />
          </Field>

          <div className="grid gap-4 border-t pt-4">
            <h3 className="font-medium">What to send</h3>
            <SignalRow
              label="Traces"
              description="Each run, its jobs and their steps, with where each job ran and how long it waited."
            >
              <Select
                value={enabled ? "on" : "off"}
                onValueChange={(value) => setEnabled(value === "on")}
              >
                <SelectTrigger aria-label="Traces" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Don't send</SelectItem>
                  <SelectItem value="on">Every run</SelectItem>
                </SelectContent>
              </Select>
            </SignalRow>
            <SignalRow
              label="Job logs"
              description="Each line under its step, when the job finishes. Up to 20 MB a job, and no copy is kept."
            >
              <Select value={logs} onValueChange={(value) => setLogs(value as LogChoice)}>
                <SelectTrigger aria-label="Job logs" className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">Don't send</SelectItem>
                  <SelectItem value="failed">Failed jobs</SelectItem>
                  <SelectItem value="all">Every job</SelectItem>
                </SelectContent>
              </Select>
            </SignalRow>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !endpoint.trim()}>
              Save
            </Button>
            {telemetry.configured && (
              <>
                <Button type="button" variant="outline" disabled={pending} onClick={test}>
                  Send test trace
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={remove}>
                  Remove
                </Button>
              </>
            )}
          </div>
          {notice && (
            <p role="status" className={notice.ok ? "text-muted-foreground" : "text-destructive"}>
              {notice.text}
            </p>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
