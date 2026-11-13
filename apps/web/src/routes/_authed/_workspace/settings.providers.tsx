import { BILLING_PROVIDERS, type BillingProviderInfo } from "@relayrunner/providers";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { ProviderMark } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { timeAgo } from "@/lib/activity";
import { errorText } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";
import { providerInfo } from "@/lib/provider-catalog";
import {
  CONNECT_ERRORS,
  connectProvider,
  listConnections,
  type ProviderConnection,
  removeConnection,
  sampleConnections,
  testConnection,
} from "@/lib/provider-connections";
import { canManage } from "@/lib/roles";
import { plural } from "@/lib/job-times";
import { minutes, money } from "@/lib/usage";

export const Route = createFileRoute("/_authed/_workspace/settings/providers")({
  loader: () => (authDisabled ? sampleConnections() : listConnections()),
  component: ProviderSettingsPage,
});

function ProviderSettingsPage() {
  const { current } = Route.useRouteContext();
  const { connections } = Route.useLoaderData();
  const manager = canManage(current.role);

  return (
    <section>
      <PageHeader title="Providers">
        Paste a read-only token from a hosted runner provider to see what it actually billed, not
        just an estimate. Tokens are stored encrypted and never shown again.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        {connections.map((connection) => (
          <ProviderCard key={connection.provider} first={connection} manager={manager} />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({ first, manager }: { first: ProviderConnection; manager: boolean }) {
  const [connection, setConnection] = useState(first);
  const [replacing, setReplacing] = useState(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const { provider, connected } = connection;
  const { name } = providerInfo(provider);
  const billing = BILLING_PROVIDERS[provider];

  async function run(action: () => Promise<void>) {
    setPending(true);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setNotice({ ok: false, text: errorText(caught, CONNECT_ERRORS) });
    } finally {
      setPending(false);
    }
  }

  const test = () =>
    run(async () => {
      const result = await testConnection(provider);
      setConnection(result.connection);
      setNotice(
        result.ok
          ? { ok: true, text: "The token works." }
          : { ok: false, text: CONNECT_ERRORS[result.error ?? ""] ?? result.message ?? "" },
      );
    });

  const remove = () => {
    if (!window.confirm(`Remove the ${name} token and the usage synced with it?`)) return;
    void run(async () => {
      setConnection(await removeConnection(provider));
      setReplacing(false);
    });
  };

  return (
    <Card className="py-4">
      <CardHeader className="flex flex-row items-center justify-between gap-3 px-4">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ProviderMark provider={provider} />
          {name}
        </CardTitle>
        {connected && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <CheckIcon aria-hidden className="size-4 text-go" />
            Connected
          </span>
        )}
      </CardHeader>
      <CardContent className="grid gap-3 px-4 text-sm">
        {connected ? (
          <ConnectionStatus connection={connection} name={name} />
        ) : (
          <p className="text-muted-foreground">{billing.reads}</p>
        )}
        {manager && (!connected || replacing) && (
          <TokenForm
            billing={billing}
            name={name}
            initialOptions={connection.options}
            pending={pending}
            replacing={replacing}
            onCancel={() => setReplacing(false)}
            onSubmit={(token, options) =>
              run(async () => {
                setConnection(await connectProvider(provider, token, options));
                setReplacing(false);
                setNotice({ ok: true, text: "Connected. The first sync starts in a moment." });
              })
            }
          />
        )}
        {manager && connected && !replacing && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={pending} onClick={test}>
              Test token
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={() => setReplacing(true)}
            >
              Replace token
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={remove}>
              Remove
            </Button>
          </div>
        )}
        {!manager && !connected && (
          <p className="text-muted-foreground">An owner or admin can connect {name}.</p>
        )}
        {notice && (
          <p role="status" className={notice.ok ? "text-muted-foreground" : "text-destructive"}>
            {notice.text}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionStatus({ connection, name }: { connection: ProviderConnection; name: string }) {
  const { accountName, tokenHint, lastSyncedAt, failure, error, recent } = connection;
  const facts = [
    accountName,
    tokenHint && `Token ending ${tokenHint}`,
    lastSyncedAt ? `Synced ${timeAgo(lastSyncedAt)}` : "Waiting for the first sync",
  ].filter(Boolean);
  return (
    <div className="grid gap-1">
      <p className="text-muted-foreground">{facts.join(" · ")}</p>
      {lastSyncedAt && (
        <p>
          {plural(recent.jobs, "job")} and {minutes(recent.billableMinutes)} billable minutes in the
          last 30 days
          {recent.costUsd != null && `, ${money(recent.costUsd)} billed`}.
        </p>
      )}
      {failure === "token_rejected" && (
        <p className="text-destructive">{name} stopped accepting this token. Paste a new one.</p>
      )}
      {failure === "error" && <p className="text-destructive">The last sync failed: {error}</p>}
    </div>
  );
}

function TokenForm({
  billing,
  name,
  initialOptions,
  pending,
  replacing,
  onCancel,
  onSubmit,
}: {
  billing: BillingProviderInfo;
  name: string;
  initialOptions: Record<string, string>;
  pending: boolean;
  replacing: boolean;
  onCancel: () => void;
  onSubmit: (token: string, options: Record<string, string>) => void;
}) {
  const [token, setToken] = useState("");
  const [options, setOptions] = useState(initialOptions);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim()) onSubmit(token.trim(), options);
  }

  return (
    <form onSubmit={submit} className="grid gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Field label={billing.token} className="min-w-0 flex-1 basis-64">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={`Paste your ${name} token`}
          />
        </Field>
        {billing.options?.map((option) => (
          <Field key={option.key} label={option.label}>
            <Select
              value={options[option.key]}
              onValueChange={(value) => setOptions({ ...options, [option.key]: value })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {option.choices.map((choice) => (
                  <SelectItem key={choice.value} value={choice.value}>
                    {choice.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ))}
        <div className="flex gap-2">
          <Button type="submit" disabled={pending || !token.trim()}>
            {replacing ? "Save" : "Connect"}
          </Button>
          {replacing && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        <Help text={billing.tokenHelp} />{" "}
        <a
          href={billing.tokenUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-0.5 text-go hover:text-go-hover"
        >
          Open {name}
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      </p>
    </form>
  );
}

/** Help text with `code` in backticks. */
function Help({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>));
}
