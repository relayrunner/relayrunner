import { Link } from "@tanstack/react-router";
import {
  BASE_BOOK,
  githubRate,
  isProviderId,
  isRate,
  labelOfEnvironment,
  listRate,
  rateText,
  runnerSize,
  sizeText,
} from "@relayrunner/providers";
import { type ReactNode, useEffect, useState } from "react";
import { ProviderMark, providerOf } from "@/components/providers";
import { CliVersion, machineView, MachineOwner, StatusDot } from "@/components/runner-card";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { deviceName } from "@/lib/device";
import type { Environment } from "@/lib/job-times";
import { cachedMachine, type Machine, workspaceMachine } from "@/lib/machines";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

/** The runner a job ran on: its Performance environment, or just its key and name. */
export type RunnerRef = Pick<Environment, "key" | "label"> & Partial<Environment>;

const MACHINE = "machine:";
const SELF_HOSTED = "self-hosted:";

/**
 * A runner's mark and name inline (in a table, a feed or a run), with a card on hover showing its
 * specs: a connected machine's hardware, VM size, CLI and status, or a cloud runner's size and
 * list price. Cloud runners link to their provider's page, machines to the Runners page.
 */
export function RunnerLink({
  runner,
  className,
  markClassName,
  specsShown = false,
  children,
}: {
  runner: RunnerRef;
  /** The row already shows the runner's detail and size, so the card leaves them out. */
  specsShown?: boolean;
  className?: string;
  markClassName?: string;
  /** What names it; its label when left out. */
  children?: ReactNode;
}) {
  const provider = providerOf(runner);
  const content = (
    <>
      <ProviderMark provider={provider} className={markClassName} />
      {children ?? runner.label}
    </>
  );
  const to =
    provider === "machine"
      ? ({ to: "/runners" } as const)
      : ({ to: "/providers/$provider", params: { provider } } as const);
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link {...to} className={cn("hover:underline hover:underline-offset-2", className)}>
          {content}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent className="w-72">
        {runner.key.startsWith(MACHINE) ? (
          <MachineCardBody id={runner.key.slice(MACHINE.length)} specsShown={specsShown} />
        ) : runner.key.startsWith(SELF_HOSTED) ? (
          <SelfHostedBody runner={runner} specsShown={specsShown} />
        ) : (
          <CloudBody runner={runner} provider={provider} specsShown={specsShown} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

// The card's first line. The name is left out, since the link that opened the card shows it.
function Lead({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{children}</div>
  );
}

/** Label-value rows, skipping the ones with nothing to say. */
function Specs({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value != null && value !== "" && value !== false);
  if (!shown.length) return null;
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs [&:not(:first-child)]:mt-3 [&:not(:first-child)]:border-t [&:not(:first-child)]:pt-3">
      {shown.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 truncate">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="mt-3 border-t pt-3 text-xs font-medium">{children}</div>;
}

// A connected machine or a runner added from GitHub: read from the workspace's machines on open.
function MachineCardBody({ id, specsShown }: { id: string; specsShown: boolean }) {
  // Straight from the cache when another card already read it, so it opens without a skeleton.
  const [machine, setMachine] = useState<Machine | null | undefined>(() => cachedMachine(id));
  useEffect(() => {
    let live = true;
    workspaceMachine(id)
      .then((found) => live && setMachine(found))
      .catch(() => live && setMachine(null));
    return () => {
      live = false;
    };
  }, [id]);
  if (machine === undefined)
    return (
      <div aria-label="Loading" className="grid gap-2">
        {[0, 1, 2].map((row) => (
          <span key={row} className="h-3 w-3/4 animate-pulse rounded bg-muted" />
        ))}
      </div>
    );
  if (machine === null || machine.revokedAt)
    return (
      <Lead>
        {machine ? "This machine was revoked." : "This machine isn't in this workspace anymore."}
      </Lead>
    );

  const view = machineView(machine);
  const device = machine.device;
  const model = device ? [deviceName(device), device.chip].filter(Boolean).join(" · ") : null;
  return (
    <>
      <Lead>
        <StatusDot connection={view.connection} />
        <span className="truncate">
          {view.label}
          {view.detail && ` · ${view.detail}`}
        </span>
      </Lead>
      <Specs
        rows={[
          ["Device", !specsShown && model],
          ["Hardware", view.hardware],
          ["Platform", view.platform],
          ["Jobs run", view.jobPlace],
          ["Runners", view.runners != null && `${view.runners} at once`],
          ["CLI", machine.cli && <CliVersion cli={machine.cli} />],
          [
            view.isGithub ? "Registered in" : "Owner",
            <MachineOwner machine={machine} view={view} />,
          ],
        ]}
      />
      <Footer>
        <Link to="/runners" className="hover:underline">
          Open in Runners →
        </Link>
      </Footer>
    </>
  );
}

// Jobs on self-hosted runners RelayRunner didn't connect, by runner group.
function SelfHostedBody({ runner, specsShown }: { runner: RunnerRef; specsShown: boolean }) {
  const group =
    !specsShown && runner.detail ? `the ${runner.detail} runner group` : "a runner group";
  return (
    <>
      <p className="text-xs text-muted-foreground">
        A self-hosted runner GitHub picked from {group}. Add it from GitHub on the Runners page to
        see its specs here.
      </p>
      <Footer>
        <Link to="/runners" className="hover:underline">
          Open Runners →
        </Link>
      </Footer>
    </>
  );
}

function CloudBody({
  runner,
  provider,
  specsShown,
}: {
  runner: RunnerRef;
  provider: string;
  specsShown: boolean;
}) {
  const { name, summary } = providerInfo(provider);
  // Keys are `<provider>:<label>`; the container's is plain `container`.
  const label = labelOfEnvironment(runner.key);
  const size = runner.size ?? runnerSize(provider, label);
  const price = listPrice(provider, label);
  const detail = runner.detail && runner.detail !== name ? runner.detail : null;
  return (
    <>
      <Specs
        rows={[
          ["Provider", detail && !specsShown ? `${name} · ${detail}` : name],
          ["Size", !specsShown && sizeText(size)],
          ["List price", price !== null && rateText(price)],
          [
            "Label",
            runner.key.includes(":") && runner.label !== label && (
              <code className="font-mono">{label}</code>
            ),
          ],
        ]}
      />
      {provider === "other" && <p className="mt-3 text-xs text-muted-foreground">{summary}</p>}
      <Footer>
        <Link to="/providers/$provider" params={{ provider }} className="hover:underline">
          Your usage on {name} →
        </Link>
      </Footer>
    </>
  );
}

/** What a minute on this runner costs at list price, or null when RelayRunner doesn't know. */
function listPrice(provider: string, label: string) {
  if (provider === "github")
    return isRate("github", label) ? githubRate(BASE_BOOK, label as never) : null;
  return isProviderId(provider) ? listRate(BASE_BOOK, provider, label) : null;
}
