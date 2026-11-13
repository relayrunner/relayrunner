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
import { ProviderMark, providerOf, providerStyle } from "@/components/providers";
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
  children,
}: {
  runner: RunnerRef;
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
      <HoverCardContent className="w-80">
        {runner.key.startsWith(MACHINE) ? (
          <MachineCardBody id={runner.key.slice(MACHINE.length)} runner={runner} />
        ) : runner.key.startsWith(SELF_HOSTED) ? (
          <SelfHostedBody runner={runner} />
        ) : (
          <CloudBody runner={runner} provider={provider} />
        )}
      </HoverCardContent>
    </HoverCard>
  );
}

function Header({
  mark,
  title,
  mono,
  sub,
}: {
  mark: ReactNode;
  title: string;
  mono?: boolean;
  sub?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {mark}
      <div className="min-w-0">
        <p className={cn("truncate font-semibold", mono && "font-mono text-[13px]")}>{title}</p>
        {sub && <div className="truncate text-xs text-muted-foreground">{sub}</div>}
      </div>
    </div>
  );
}

/** Label-value rows, skipping the ones with nothing to say. */
function Specs({ rows }: { rows: [string, ReactNode][] }) {
  const shown = rows.filter(([, value]) => value != null && value !== "" && value !== false);
  if (!shown.length) return null;
  return (
    <dl className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t pt-3 text-xs">
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
  return <div className="mt-3 text-xs font-medium">{children}</div>;
}

// A connected machine or a runner added from GitHub: read from the workspace's machines on open.
function MachineCardBody({ id, runner }: { id: string; runner: RunnerRef }) {
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
  const mark = <ProviderMark provider="machine" className="size-7 rounded-md" />;

  if (machine === undefined)
    return (
      <>
        <Header mark={mark} title={runner.label} mono sub="Loading…" />
        <div aria-hidden className="mt-3 grid gap-2 border-t pt-3">
          {[0, 1, 2].map((row) => (
            <span key={row} className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          ))}
        </div>
      </>
    );
  if (machine === null || machine.revokedAt)
    return (
      <>
        <Header mark={mark} title={runner.label} mono sub={runner.detail || "Self-hosted"} />
        <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
          {machine ? "This machine was revoked." : "This machine isn't in this workspace anymore."}
        </p>
      </>
    );

  const view = machineView(machine);
  const device = machine.device;
  const model = device ? [deviceName(device), device.chip].filter(Boolean).join(" · ") : null;
  return (
    <>
      <Header
        mark={mark}
        title={machine.name}
        mono
        sub={
          <span className="flex min-w-0 items-center gap-1.5">
            <StatusDot connection={view.connection} />
            <span className="truncate">
              {view.label}
              {view.detail && ` · ${view.detail}`}
            </span>
          </span>
        }
      />
      <Specs
        rows={[
          ["Device", model],
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
function SelfHostedBody({ runner }: { runner: RunnerRef }) {
  return (
    <>
      <Header
        mark={<ProviderMark provider="machine" className="size-7 rounded-md" />}
        title={runner.label}
        sub={runner.detail && `${runner.detail} runner group`}
      />
      <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">
        A self-hosted runner GitHub picked from this group. Add it from GitHub on the Runners page
        to see its specs here.
      </p>
      <Footer>
        <Link to="/runners" className="hover:underline">
          Open Runners →
        </Link>
      </Footer>
    </>
  );
}

function CloudBody({ runner, provider }: { runner: RunnerRef; provider: string }) {
  const { name, summary } = providerInfo(provider);
  const { mono } = providerStyle(provider);
  // Keys are `<provider>:<label>`; the container's is plain `container`.
  const label = labelOfEnvironment(runner.key);
  const size = runner.size ?? runnerSize(provider, label);
  const price = listPrice(provider, label);
  const detail = runner.detail && runner.detail !== name ? runner.detail : null;
  return (
    <>
      <Header
        mark={<ProviderMark provider={provider} className="size-7 rounded-md" />}
        title={runner.label}
        mono={mono}
        sub={detail ? `${name} · ${detail}` : name}
      />
      <Specs
        rows={[
          ["Size", sizeText(size)],
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
