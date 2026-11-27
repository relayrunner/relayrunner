// Evaluate's Connect step for Boat. "Sign in with boat" connects the account in one trip, and Boat
// then says itself what's still missing before it runs the workspace's jobs: its $20 plan (CI
// doesn't run on the trial) and its CI GitHub App on the workspace's GitHub account. Each missing
// piece links to where to fix it, and the page moves on by itself once Boat reports it done.
import { useSearch } from "@tanstack/react-router";
import { ArrowUpRightIcon, CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { EVALUATE_STEP, EvaluateStepper } from "@/components/evaluate-stepper";
import { errorText } from "@/lib/api";
import {
  BOAT_BILLING_URL,
  BOAT_CI_URL,
  type BoatReadiness,
  boatConnectUrl,
  getBoatReadiness,
} from "@/lib/boat-readiness";
import { cn } from "@/lib/utils";

// Quicker than the other setup checks: the person is usually waiting on this one, and each read is
// two small calls to Boat.
const POLL_MS = 5_000;

/** Reads readiness now, every POLL_MS until ready, and whenever the tab comes back into view. */
function useBoatReadiness() {
  const [value, setValue] = useState<BoatReadiness | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const ready = value?.ready ?? false;
  useEffect(() => {
    let live = true;
    const run = () =>
      getBoatReadiness().then(
        (next) => live && (setValue(next), setError(null)),
        (caught) => live && setError(errorText(caught)),
      );
    void run();
    if (ready) return () => void (live = false);
    const timer = setInterval(run, POLL_MS);
    // Back from Boat's or GitHub's tab: look again at once.
    const onFocus = () => document.visibilityState === "visible" && void run();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [ready]);
  return { value, error };
}

export function BoatSetup({
  provider,
  editable,
  fallback,
  choose,
}: {
  provider: string;
  editable: boolean;
  /** The plain install-the-app step, for when Boat's sign-in isn't set up or can't be read. */
  fallback: ReactNode;
  choose: (repoNote: (repository: string) => ReactNode) => ReactNode;
}) {
  const { value, error } = useBoatReadiness();
  if (value === undefined && !error)
    return <EvaluateStepper at={EVALUATE_STEP.provider} provider={provider} />;
  if (!value || !value.signIn) return fallback;
  if (value.ready)
    return (
      <>
        <EvaluateStepper at={EVALUATE_STEP.choose} provider={provider} />
        {choose((repository) => repoNote(value, repository))}
      </>
    );
  return (
    <>
      <EvaluateStepper at={EVALUATE_STEP.provider} provider={provider} />
      <BoatChecklist readiness={value} editable={editable} />
    </>
  );
}

/** Why Boat won't run jobs from the picked repository yet, or null when it will. */
function repoNote(readiness: BoatReadiness, repository: string): ReactNode {
  const repo = readiness.install?.repositories.find(
    (r) => r.fullName.toLowerCase() === repository.toLowerCase(),
  );
  if (repo && (repo.status === "public-blocked" || !repo.private))
    return (
      <>
        <span className="font-medium">Boat doesn't run jobs from public repositories.</span>
        <span className="text-muted-foreground">
          Pick a private repository, or allow this one in Boat's CI tab.
        </span>
      </>
    );
  if (repo) return null;
  const manage = readiness.install?.manageUrl;
  return (
    <>
      <span className="font-medium">Boat's GitHub App can't see {repository} yet.</span>
      <span className="text-muted-foreground">
        Add it to the app's repositories on GitHub; this updates within a few seconds.{" "}
        {manage && (
          <a href={manage} target="_blank" rel="noreferrer" className="font-medium underline">
            Choose repositories
          </a>
        )}
      </span>
    </>
  );
}

type StepState = "done" | "todo" | "waiting";

function BoatChecklist({ readiness, editable }: { readiness: BoatReadiness; editable: boolean }) {
  const outcome: { boat?: string } = useSearch({ strict: false });
  const account = readiness.connected && !readiness.rejected;
  const plan = readiness.plan;
  const github = readiness.githubAccount ?? "your GitHub account";
  const next = `${window.location.pathname}`;
  const connectButton = (label: string) =>
    editable ? (
      <Button size="sm" asChild>
        <a href={boatConnectUrl(next)}>
          {label}
          <ArrowUpRightIcon className="size-3.5" />
        </a>
      </Button>
    ) : (
      <span className="text-xs text-muted-foreground">Ask an owner or admin to connect Boat.</span>
    );
  const link = (href: string, label: string) => (
    <Button size="sm" variant="outline" asChild>
      <a href={href} target="_blank" rel="noreferrer">
        {label}
        <ArrowUpRightIcon className="size-3.5" />
      </a>
    </Button>
  );

  return (
    <div className="grid max-w-3xl gap-4">
      {outcome.boat === "cancelled" && !account && (
        <p className="text-sm text-muted-foreground">
          Boat wasn't connected. Try again when ready.
        </p>
      )}
      {outcome.boat === "failed" && !account && (
        <p className="text-sm text-destructive">Boat didn't finish connecting. Try again.</p>
      )}
      <div className="grid gap-4 rounded-xl border bg-card p-5">
        <div className="grid gap-1">
          <span className="font-semibold">Set up Boat</span>
          <span className="text-sm text-muted-foreground">
            Boat runs jobs from private repositories, on its $20 plan or higher, for GitHub accounts
            with its CI app installed. This page checks each one and moves on by itself.
          </span>
        </div>
        <ol className="grid gap-3 border-t pt-4 text-sm">
          <Step
            n={1}
            state={account ? "done" : "todo"}
            title={
              account
                ? `Boat account connected${readiness.accountName ? ` (${readiness.accountName})` : ""}`
                : "Connect your Boat account"
            }
            detail={
              readiness.rejected
                ? "Boat stopped accepting the connection. Connect it again."
                : account
                  ? null
                  : "Sign in or sign up on Boat. RelayRunner only reads your plan, limits and CI setup."
            }
            action={
              account ? null : connectButton(readiness.rejected ? "Reconnect Boat" : "Connect Boat")
            }
          />
          <Step
            n={2}
            state={!account || !plan ? "waiting" : plan.runsCi ? "done" : "todo"}
            title={plan?.runsCi ? "On a plan that runs CI" : "Start Boat's $20 plan"}
            detail={
              !account || !plan
                ? "Boat runs CI jobs on its $20 plan or higher."
                : plan.runsCi
                  ? null
                  : (plan.blockedReason ??
                    (plan.key === "trial"
                      ? "You're on Boat's free trial, which doesn't run CI jobs."
                      : "Boat runs CI jobs on its $20 plan or higher."))
            }
            action={
              account && plan && !plan.runsCi ? link(BOAT_BILLING_URL, "Choose a plan") : null
            }
          />
          <Step
            n={3}
            state={!account ? "waiting" : readiness.install ? "done" : "todo"}
            title={
              readiness.install
                ? `Boat's GitHub App is on ${github}`
                : `Install Boat's GitHub App on ${github}`
            }
            detail={
              readiness.install
                ? null
                : "In Boat's CI tab, connect GitHub and pick the repositories Boat may run."
            }
            action={account && !readiness.install ? link(BOAT_CI_URL, "Open Boat's CI tab") : null}
          />
        </ol>
        {account && (
          <div className="flex items-center gap-2 border-t pt-4 text-sm text-muted-foreground">
            {readiness.unreachable ? (
              <>
                <TriangleAlertIcon aria-hidden className="size-4 text-run" />
                Couldn't reach Boat just now. Trying again.
              </>
            ) : (
              <>
                <LoaderCircleIcon aria-hidden className="size-4 animate-spin text-run" />
                Checking Boat every few seconds
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Step({
  n,
  state,
  title,
  detail,
  action,
}: {
  n: number;
  state: StepState;
  title: string;
  detail: ReactNode;
  action: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3">
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full border text-xs",
          state === "done" && "border-go-edge bg-go-soft text-go",
          state === "waiting" && "text-muted-foreground",
        )}
      >
        {state === "done" ? <CheckIcon aria-label="Done" className="size-3" /> : n}
      </span>
      <span className={cn("grid min-w-0 flex-1 gap-0.5", state === "waiting" && "opacity-60")}>
        <span className="font-medium">{title}</span>
        {detail && <span className="text-muted-foreground">{detail}</span>}
      </span>
      {action}
    </li>
  );
}
