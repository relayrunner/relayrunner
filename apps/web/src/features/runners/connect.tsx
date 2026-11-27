// What the Runners page shows before a workspace has a machine: how to connect one.
import { RUNNER_LABELS, type RunnerKey, type RunnerStep } from "@relayrunner/runner-order";
import { CheckIcon, CirclePlayIcon, CloudIcon, CopyIcon, LaptopIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { CONNECT_COMMAND, CopyCommand } from "@/components/add-runner";
import { MacAppButton, MacAppLink, ON_MAC } from "@/components/mac-app";
import { DOCS_URL } from "@/components/site-footer";
import { GithubIcon } from "@/components/provider-logos";
import { FOUND_PREVIEW, FoundRunnerRows } from "@/components/runner-card";
import { Button } from "@/components/ui/button";
import { type AddableRunner } from "@/lib/machines";
import { cn } from "@/lib/utils";

// Where a job goes when no self-hosted runner can take it: the first step after self-hosted.
export function fallbackAfterMachine(steps: RunnerStep[]): RunnerKey | null {
  const at = steps.findIndex((step) => step.key === "machine");
  return steps.slice(at + 1).find((step) => step.key !== "machine")?.key ?? null;
}

// No self-hosted runners yet: the section says what connecting does, then hands over the one command.
export function ConnectLanding({
  fallback,
  found,
  onAddFound,
  onAddExisting,
}: {
  fallback: RunnerKey | null;
  /** Runners already on GitHub that could be added. */
  found: AddableRunner[];
  onAddFound: (runner: AddableRunner) => Promise<void>;
  /** Missing for members, who can't add runners from GitHub. */
  onAddExisting?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(CONNECT_COMMAND);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked; the command is still there to select.
    }
  }
  const elsewhere =
    fallback === "github"
      ? {
          icon: <GithubIcon className="size-5" />,
          name: "GitHub-hosted",
          when: "when it's closed, asleep or busy",
        }
      : fallback
        ? {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: RUNNER_LABELS[fallback],
            when: "when it's closed, asleep or busy",
          }
        : {
            icon: <CloudIcon aria-hidden className="size-5" />,
            name: "Nowhere",
            when: "jobs that need it stop early",
          };

  return (
    <div className="grid gap-10 rounded-xl border border-dashed px-5 py-8 sm:px-10 sm:py-12">
      <figure
        aria-label="Where a private repo job runs"
        className="m-0 grid w-fit gap-4 justify-self-center sm:flex sm:items-center sm:gap-0"
      >
        <span className="flex items-center gap-2 justify-self-start rounded-full border bg-card px-4 py-2.5 text-sm whitespace-nowrap text-ink-2">
          <CirclePlayIcon aria-hidden className="size-[18px]" />
          Private repo job
        </span>
        {/* Wide screens: the job forks to the right. */}
        <svg
          aria-hidden
          viewBox="0 0 110 190"
          className="hidden h-[190px] w-[110px] shrink-0 sm:block"
        >
          <path d="M0 95 C55 95 55 38 110 38" fill="none" className="stroke-go" strokeWidth="2" />
          <path
            d="M0 95 C55 95 55 152 110 152"
            fill="none"
            className="stroke-idle"
            strokeWidth="2"
            strokeDasharray="4 5"
          />
        </svg>
        <div className="relative grid gap-4 pl-11 sm:gap-16 sm:pl-0">
          {/* Phones: the job drops down from the pill, to the laptop first and then on down. */}
          <span
            aria-hidden
            className="absolute top-[-16px] bottom-[22px] left-[24px] w-5 rounded-bl-lg border-b-2 border-l-2 border-dashed border-idle sm:hidden"
          />
          <div className="relative">
            <span
              aria-hidden
              className="absolute top-[-16px] bottom-1/2 left-[-20px] w-5 rounded-bl-lg border-b-2 border-l-2 border-go sm:hidden"
            />
            <RouteEnd
              on
              icon={<LaptopIcon aria-hidden className="size-5" />}
              name="Your laptop"
              when={<>while it's connected</>}
            />
          </div>
          <RouteEnd icon={elsewhere.icon} name={elsewhere.name} when={elsewhere.when} />
        </div>
      </figure>

      <div className="grid justify-items-center gap-3">
        {ON_MAC && (
          <>
            <MacAppButton size="default" />
            <p className="text-center text-sm text-muted-foreground">Or run this in a terminal:</p>
          </>
        )}
        <div className="flex w-full max-w-md items-center justify-between gap-3 rounded-md border bg-card py-2 pr-2 pl-4 font-mono text-sm">
          <span className="truncate">
            <span aria-hidden className="text-muted-foreground select-none">
              ${" "}
            </span>
            {CONNECT_COMMAND}
          </span>
          <Button size="sm" className="font-sans" onClick={() => void copy()}>
            {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        {!ON_MAC && (
          <p className="text-center text-sm text-muted-foreground">
            Run it in a terminal on the computer you want CI on. On a Mac? <MacAppLink />
          </p>
        )}
        {onAddExisting && found.length > 0 && (
          <div className="mt-3 grid w-full max-w-md gap-1">
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <GithubIcon className="size-4" />
              Or add {found.length === 1 ? "the runner" : `the ${found.length} runners`} already on
              GitHub
            </p>
            <FoundRunnerRows runners={found} onAdd={onAddFound} />
            {found.length > FOUND_PREVIEW && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={onAddExisting}
              >
                See all {found.length}
              </Button>
            )}
          </div>
        )}
        {onAddExisting && found.length === 0 && (
          <Button variant="ghost" size="sm" className="mt-1" onClick={onAddExisting}>
            <GithubIcon />
            Already have a self-hosted runner? Add it
          </Button>
        )}
      </div>
    </div>
  );
}

// Beside other runners, for a user who hasn't connected a computer yet: the landing's command, small.
export function ConnectCard({ onDismiss }: { onDismiss: () => void }) {
  return (
    <article
      aria-label="Connect your computer"
      className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-dashed"
    >
      <div className="grid min-w-0 gap-2.5 px-4 pt-3 pb-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-dashed text-muted-foreground">
            <LaptopIcon aria-hidden className="size-3.5" />
          </span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">Run jobs on your computer</h3>
          <Button
            size="icon-sm"
            variant="ghost"
            className="-my-1 -mr-2 shrink-0 text-muted-foreground"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <XIcon aria-hidden />
          </Button>
        </div>
        {ON_MAC && <MacAppButton />}
        <CopyCommand command={CONNECT_COMMAND} />
        <p className="text-xs text-muted-foreground">
          {ON_MAC ? "Or run the command in a terminal. " : "Run it in a terminal. "}
          Your computer takes jobs while it's connected.
          {!ON_MAC && (
            <>
              {" "}
              On a Mac? <MacAppLink />
            </>
          )}
        </p>
      </div>
      <div className="mt-auto flex min-h-10 items-center border-t border-dashed px-4 py-2 text-xs">
        <a
          href={`${DOCS_URL}/get-started/quickstart`}
          target="_blank"
          rel="noreferrer"
          className="-mx-1 rounded-sm px-1 font-semibold text-go outline-none hover:text-go-hover focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          See the quickstart
        </a>
      </div>
    </article>
  );
}

// One end of the route diagram: where the job lands, and when.
function RouteEnd({
  on = false,
  icon,
  name,
  when,
}: {
  on?: boolean;
  icon: ReactNode;
  name: string;
  when: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5">
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-[10px] border",
          on ? "border-go-edge bg-go-soft text-go" : "bg-card text-ink-2",
        )}
      >
        {icon}
      </span>
      <span className="grid">
        <span className="text-[15px] font-semibold">{name}</span>
        <span className="text-sm text-muted-foreground">{when}</span>
      </span>
    </div>
  );
}
