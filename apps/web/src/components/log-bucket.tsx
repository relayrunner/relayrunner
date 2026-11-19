import { type FormEvent, useState } from "react";
import { ExportStatus } from "@/components/export-status";
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
import {
  BUCKET_PRESETS,
  type LogBucket,
  type LogChoice,
  removeLogBucket,
  saveLogBucket,
  testLogBucket,
} from "@/lib/telemetry";

type PresetId = (typeof BUCKET_PRESETS)[number]["id"];

const presetFor = (bucket: LogBucket): PresetId => {
  if (!bucket.configured) return BUCKET_PRESETS[0].id;
  const host = URL.parse(bucket.endpoint)?.hostname ?? "";
  if (host.endsWith(".amazonaws.com")) return "s3";
  if (host.endsWith(".r2.cloudflarestorage.com")) return "r2";
  if (host === "storage.googleapis.com") return "gcs";
  return "other";
};

/** Settings → Telemetry: archive job logs to an S3-compatible bucket. */
export function LogBucketSection({
  bucket,
  onChange,
  manager,
}: {
  bucket: LogBucket;
  onChange: (bucket: LogBucket) => void;
  manager: boolean;
}) {
  return (
    <div className="grid gap-2">
      <h2 className="text-base font-medium">Log archive</h2>
      <p className="text-sm text-muted-foreground">
        Keep job logs in your own bucket: one gzipped NDJSON file per job, at{" "}
        <code className="text-xs">owner/repo/yyyy/mm/dd/run-attempt/job.ndjson.gz</code>.
      </p>
      <BucketStatus bucket={bucket} />
      {manager ? (
        <BucketForm bucket={bucket} onChange={onChange} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {bucket.configured
            ? `Job logs go to the ${bucket.bucket} bucket. An owner or admin can change this.`
            : "An owner or admin can set up a log archive."}
        </p>
      )}
    </div>
  );
}

function BucketStatus({ bucket }: { bucket: LogBucket }) {
  if (!bucket.configured) return null;
  return (
    <ExportStatus
      status={bucket}
      on={bucket.logs !== "off"}
      off="Off. Logs aren't being archived."
      sent="Last written"
      waiting="Waiting for the next job."
    />
  );
}

function BucketForm({
  bucket,
  onChange,
}: {
  bucket: LogBucket;
  onChange: (bucket: LogBucket) => void;
}) {
  const first = BUCKET_PRESETS[0];
  const [preset, setPreset] = useState<PresetId>(presetFor(bucket));
  const [endpoint, setEndpoint] = useState(bucket.configured ? bucket.endpoint : first.endpoint);
  const [name, setName] = useState(bucket.bucket);
  const [region, setRegion] = useState(bucket.configured ? bucket.region : first.region);
  const [prefix, setPrefix] = useState(bucket.prefix);
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [logs, setLogs] = useState<LogChoice>(bucket.configured ? bucket.logs : "failed");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const help = BUCKET_PRESETS.find((p) => p.id === preset)?.help;

  function choosePreset(id: PresetId) {
    const next = BUCKET_PRESETS.find((p) => p.id === id)!;
    setPreset(id);
    setEndpoint(next.endpoint);
    setRegion(next.region);
  }

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
      const saved = await saveLogBucket({
        endpoint,
        bucket: name,
        region,
        prefix,
        // Blank keeps the saved key.
        ...(accessKeyId.trim() && { accessKeyId: accessKeyId.trim() }),
        ...(secret.trim() && { secretAccessKey: secret.trim() }),
        logs,
      });
      onChange(saved);
      setPrefix(saved.prefix);
      setAccessKeyId("");
      setSecret("");
      setNotice({ ok: true, text: "Saved. Write a test file to check it works." });
    });
  }

  const test = () =>
    run(async () => {
      const { sent, bucket: next } = await testLogBucket();
      onChange(next);
      setNotice(
        sent.ok
          ? { ok: true, text: `Wrote ${next.prefix}relayrunner-test.ndjson.gz to ${next.bucket}.` }
          : { ok: false, text: `The bucket refused it: ${sent.error}` },
      );
    });

  const remove = () => {
    if (!window.confirm("Stop archiving job logs and forget these settings?")) return;
    void run(async () => {
      onChange(await removeLogBucket());
      choosePreset(first.id);
      setName("");
      setPrefix("");
      setLogs("failed");
    });
  };

  return (
    <Card className="py-4">
      <CardContent className="px-4">
        <form onSubmit={submit} className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Service">
              <Select value={preset} onValueChange={(id) => choosePreset(id as PresetId)}>
                <SelectTrigger className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BUCKET_PRESETS.map((p) => (
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
                placeholder="https://s3.example.com"
              />
            </Field>
          </div>
          {help && <p className="-mt-2 text-xs text-muted-foreground">{help}</p>}

          <div className="flex flex-wrap gap-3">
            <Field label="Bucket" className="min-w-0 flex-1 basis-40">
              <Input
                required
                spellCheck={false}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ci-logs"
              />
            </Field>
            <Field label="Region" className="w-36">
              <Input
                spellCheck={false}
                value={region}
                onChange={(e) => setRegion(e.target.value)}
                placeholder="auto"
              />
            </Field>
            <Field label="Folder" className="min-w-0 flex-1 basis-40">
              <Input
                spellCheck={false}
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="Optional, like github/"
              />
            </Field>
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap gap-3">
              <Field label="Access key ID" className="min-w-0 flex-1 basis-48">
                <Input
                  autoComplete="off"
                  spellCheck={false}
                  required={!bucket.configured}
                  value={accessKeyId}
                  onChange={(e) => setAccessKeyId(e.target.value)}
                  placeholder={bucket.configured ? `Saved, ending ${bucket.keyHint}` : ""}
                />
              </Field>
              <Field label="Secret access key" className="min-w-0 flex-1 basis-48">
                <Input
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  required={!bucket.configured || !!accessKeyId.trim()}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={bucket.configured ? "Saved" : ""}
                />
              </Field>
            </div>
            <p className="text-xs text-muted-foreground">
              Stored encrypted and never shown again. Leave both blank to keep the saved key. The
              key only needs to write objects.
            </p>
          </div>

          <Field
            label="Archive"
            hint="When a job finishes, its log goes from GitHub to the bucket, up to 20 MB. No other copy is kept."
            className="max-w-xs"
          >
            <Select value={logs} onValueChange={(value) => setLogs(value as LogChoice)}>
              <SelectTrigger className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="off">Nothing</SelectItem>
                <SelectItem value="failed">Failed jobs</SelectItem>
                <SelectItem value="all">Every job</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={pending || !endpoint.trim() || !name.trim()}>
              Save
            </Button>
            {bucket.configured && (
              <>
                <Button type="button" variant="outline" disabled={pending} onClick={test}>
                  Write test file
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
