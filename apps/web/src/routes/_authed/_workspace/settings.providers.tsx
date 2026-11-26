import { AppError, ERRORS, isErrorCode } from "@relayrunner/errors";
import { BILLING_PROVIDERS, type BillingProviderInfo } from "@relayrunner/providers";
import { heldText } from "@relayrunner/activity";
import {
  type FreeMinutesProvider,
  isFreeMinutesProvider,
  RUNNER_LABELS,
} from "@relayrunner/runner-order";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon, CopyIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { FreeMinutesMeter } from "@/components/free-minutes-meter";
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
import {
  counted,
  type FreeMinutes as FreeMinutesCount,
  type FreeMinutesByProvider,
  getAllFreeMinutes,
} from "@/lib/free-minutes";
import { providerInfo } from "@/lib/provider-catalog";
import {
  connectProvider,
  listConnections,
  type ProviderConnection,
  removeConnection,
  testConnection,
} from "@/lib/provider-connections";
import { canManage } from "@/lib/roles";
import { plural } from "@/lib/job-times";
import { minutes, money } from "@/lib/usage";

export const Route = createFileRoute("/_authed/_workspace/settings/providers")({
  loader: async () => {
    const [{ connections }, freeMinutes] = await Promise.all([
      listConnections(),
      // Only for the Blacksmith and Groundbox cards' free-minutes lines, so the page loads without.
      getAllFreeMinutes().catch((): FreeMinutesByProvider => ({})),
    ]);
    return { connections, freeMinutes };
  },
  component: ProviderSettingsPage,
});

function ProviderSettingsPage() {
  const { current } = Route.useRouteContext();
  const { connections, freeMinutes } = Route.useLoaderData();
  const manager = canManage(current.role);
  const organization = current.installations[0]?.accountLogin ?? null;

  return (
    <section>
      <PageHeader className="max-w-3xl" title="Providers">
        Paste a read-only token from a hosted runner provider to see what it actually billed, not
        just an estimate. Tokens are stored encrypted and never shown again.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        {connections.map((connection) => (
          <ProviderCard
            key={connection.provider}
            first={connection}
            manager={manager}
            organization={organization}
            freeMinutes={
              isFreeMinutesProvider(connection.provider)
                ? (freeMinutes[connection.provider] ?? null)
                : undefined
            }
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  first,
  manager,
  organization,
  freeMinutes,
}: {
  first: ProviderConnection;
  manager: boolean;
  /** The GitHub organization this workspace is installed on. */
  organization: string | null;
  /** Blacksmith's and Groundbox's cards only: this month's free minutes, null when unread. */
  freeMinutes?: FreeMinutesCount | null;
}) {
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
      // A missing scope is the one refusal that says how to fix the token, so name it.
      const reason =
        caught instanceof AppError
          ? scopeError(String((caught.details as { reason?: unknown })?.reason ?? ""))
          : null;
      setNotice({
        ok: false,
        text: reason ? `${name} refused the ${billing.token}: ${reason}.` : errorText(caught),
      });
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
          : {
              ok: false,
              text: isErrorCode(result.error)
                ? ERRORS[result.error].message
                : (result.message ?? ""),
            },
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
        {freeMinutes !== undefined && isFreeMinutesProvider(provider) && (
          <FreeMinutes
            provider={provider}
            connected={connected}
            minutes={connected ? freeMinutes : null}
          />
        )}
        {manager && billing.command && !connected && (
          <ConnectCommand
            command={billing.command}
            name={name}
            organization={billing.githubOrganization ? organization : null}
          />
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
      {BILLING_PROVIDERS[connection.provider].limitsOnly ? (
        <p>{BILLING_PROVIDERS[connection.provider].reads}</p>
      ) : BILLING_PROVIDERS[connection.provider].costOnly ? (
        // The provider says what each job cost, not how long it ran.
        lastSyncedAt && (
          <p>
            {plural(recent.jobs, "job")} in the last 30 days
            {recent.costUsd != null && `, ${money(recent.costUsd)} billed`}.
          </p>
        )
      ) : (
        lastSyncedAt && (
          <p>
            {plural(recent.jobs, "job")} and {minutes(recent.billableMinutes)}{" "}
            {connection.provider === "blacksmith"
              ? // Blacksmith bills minutes times vCPUs: a minute on 4 vCPU is 4 of these.
                "vCPU minutes"
              : "billable minutes"}{" "}
            in the last 30 days
            {recent.costUsd != null && `, ${money(recent.costUsd)} billed`}.
          </p>
        )
      )}
      {failure === "token_rejected" && (
        <p className="text-destructive">
          {scopeError(error)
            ? `${name} refused this ${BILLING_PROVIDERS[connection.provider].token}: ${scopeError(error)}. Replace it with one that has that scope.`
            : `${name} stopped accepting this token. Paste a new one.`}
        </p>
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
      {billing.scopes && <Scopes scopes={billing.scopes} />}
    </form>
  );
}

/** A command that connects the provider from a terminal, with a copy button. */
function ConnectCommand({
  command,
  name,
  organization,
}: {
  command: string;
  name: string;
  organization: string | null;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(command).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  return (
    <div className="grid gap-2">
      <p>
        Run this in a terminal as a {name} org admin. It opens your browser to approve an org token
        {organization ? (
          <>
            {" "}
            for <strong>{organization}</strong>, the GitHub organization this workspace is on
          </>
        ) : (
          " for this workspace's GitHub organization"
        )}
        , and sends only that token here.
      </p>
      <div className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{command}</code>
        <Button size="sm" variant="ghost" onClick={copy} aria-label="Copy command">
          {copied ? (
            <CheckIcon aria-hidden className="size-4" />
          ) : (
            <CopyIcon aria-hidden className="size-4" />
          )}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        The computer needs to be signed in with <code>relayrunner login</code>. Or paste a token
        below.
      </p>
    </div>
  );
}

/**
 * Once Blacksmith or Groundbox is connected, this month's free minutes (and for Groundbox, whether
 * it's holding jobs).
 */
function FreeMinutes({
  provider,
  connected,
  minutes,
}: {
  provider: FreeMinutesProvider;
  connected: boolean;
  minutes: FreeMinutesCount | null;
}) {
  const label = RUNNER_LABELS[provider];
  const router = (text: string) => (
    <Link to="/router" className="text-go hover:text-go-hover">
      {text}
    </Link>
  );
  if (!connected) return null;
  const held = minutes?.held ? (
    <p className="text-destructive">
      {heldText(label, { reason: minutes.held })}, so the Router passes its jobs on.
    </p>
  ) : null;
  if (!counted(minutes)) return held;
  return (
    <>
      <FreeMinutesMeter provider={provider} minutes={minutes} />
      <p className="text-muted-foreground">
        Set a limit on the {label} step in the {router("Router")}.
      </p>
      {held}
    </>
  );
}

/** Help text with `code` in backticks. */
/** The scopes a token needs, by the token field, so it's made right the first time. */
function Scopes({ scopes }: { scopes: NonNullable<BillingProviderInfo["scopes"]> }) {
  return (
    <div className="grid gap-1.5 rounded-md border bg-muted/40 px-3 py-2.5 text-xs">
      <p className="font-medium">Scopes to give it</p>
      <ul className="grid gap-1">
        {scopes.map(({ scope, for: purpose }) => (
          <li key={scope} className="flex flex-wrap items-baseline gap-x-2">
            <code className="rounded bg-background px-1.5 py-0.5 font-mono">{scope}</code>
            <span className="text-muted-foreground">{purpose}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A provider's "missing scope" reason, which says how to fix the token; other refusals don't. */
function scopeError(error: string | null): string | null {
  const match = error?.match(/"message":"([^"]*scope[^"]*)"/i);
  return match ? match[1]!.charAt(0).toLowerCase() + match[1]!.slice(1) : null;
}

function Help({ text }: { text: string }) {
  return text
    .split("`")
    .map((part, i) => (i % 2 ? <code key={i}>{part}</code> : <span key={i}>{part}</span>));
}
