import { AppError } from "@relayrunner/errors";
import { useQuery } from "@tanstack/react-query";
import { CatchBoundary } from "@tanstack/react-router";
import { ChevronDownIcon, ExternalLinkIcon, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { type FailureCause, getJobFailure, type JobFailure } from "@/lib/runs";
import { plural } from "@/lib/job-times";
import { cn } from "@/lib/utils";

type Problem = { text: string; retry: boolean };

function problemOf(caught: unknown): Problem {
  const code = caught instanceof AppError ? caught.code : null;
  if (code === "FORBIDDEN")
    return { text: "You need access to this repo on GitHub to see its log here.", retry: false };
  if (code === "GITHUB_RATE_LIMITED")
    return {
      text: "GitHub's API limit for this account is nearly used up, so the log is paused for a few minutes.",
      retry: true,
    };
  return { text: "Couldn't load the log from GitHub.", retry: true };
}

/**
 * Why a failed job failed, in its History panel: the step that broke, GitHub's annotations and the
 * end of its log up to the last error. Read from GitHub when the panel opens; never stored. When
 * it can't be shown, even if it crashes, it links to the job's output on GitHub (`logUrl`).
 */
export function JobFailureSection({
  jobId,
  logUrl,
  hideCause = false,
  compact = false,
}: {
  jobId: number;
  logUrl: string;
  /** Leaves out the model's guess, when the page already says what went wrong. */
  hideCause?: boolean;
  /**
   * Shows only the log's error lines, with the rest a click away, and leaves out annotations those
   * lines already say (the Evaluate page, where the failure sits above the results).
   */
  compact?: boolean;
}) {
  return (
    <section className="grid gap-2">
      <CatchBoundary
        getResetKey={() => jobId}
        errorComponent={({ reset }) => (
          <>
            <Heading failure={undefined} />
            <ProblemNote
              problem={{ text: "Something broke while showing the log.", retry: true }}
              logUrl={logUrl}
              onRetry={reset}
            />
          </>
        )}
      >
        <FailureDetail jobId={jobId} logUrl={logUrl} hideCause={hideCause} compact={compact} />
      </CatchBoundary>
    </section>
  );
}

function Heading({ failure }: { failure: JobFailure | undefined }) {
  return (
    <h3 className="text-sm font-medium">
      {failure?.failedStep
        ? `Failed at step ${failure.failedStep.replace(/^(\d+)\. /, "$1: ")}`
        : "Why it failed"}
    </h3>
  );
}

function FailureDetail({
  jobId,
  logUrl,
  hideCause,
  compact,
}: {
  jobId: number;
  logUrl: string;
  hideCause: boolean;
  compact: boolean;
}) {
  // A failed job's failure doesn't change, so it's read once.
  const query = useQuery({
    queryKey: ["job-failure", jobId],
    queryFn: () => getJobFailure(jobId),
    staleTime: Infinity,
  });
  // Undefined while loading.
  const failure = query.data;
  // A retry shows the skeleton again until it answers.
  const problem = query.isError && !query.isFetching ? problemOf(query.error) : null;
  const retry = () => void query.refetch();
  const errorLines = failure?.log?.filter((line) => line.startsWith("##[error]")) ?? [];
  // Compact, an annotation whose text is already an error line in the log isn't said twice.
  const annotations =
    failure?.annotations.filter(
      (message) => !compact || !errorLines.some((line) => line.includes(message)),
    ) ?? [];

  return (
    <>
      <Heading failure={failure} />
      {problem ? (
        <ProblemNote problem={problem} logUrl={logUrl} onRetry={retry} />
      ) : failure === undefined ? (
        <div aria-busy aria-label="Loading the log" className="h-32 rounded-lg border" />
      ) : (
        <>
          {failure.cause && !hideCause && <CauseNote cause={failure.cause} />}
          {failure.runnerFailed && (
            <p className="text-sm">The runner failed the job before any step ran.</p>
          )}
          {annotations.length > 0 && (
            <ul className="grid gap-1 text-sm">
              {annotations.map((message, index) => (
                <li key={index} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          )}
          {failure.log === null ? (
            <p className="text-sm text-muted-foreground">GitHub no longer has this job's log.</p>
          ) : failure.log.length > 0 ? (
            compact && errorLines.length > 0 ? (
              <CompactLog lines={failure.log} errors={errorLines} />
            ) : (
              <LogLines lines={failure.log} />
            )
          ) : (
            !failure.runnerFailed &&
            failure.annotations.length === 0 && (
              <ProblemNote
                problem={{ text: "GitHub didn't send any log lines for this job.", retry: false }}
                logUrl={logUrl}
              />
            )
          )}
        </>
      )}
    </>
  );
}

const CAUSES: Record<FailureCause["kind"], string> = {
  flaky: "This looks like a flaky failure",
  lint: "This looks like a lint, format or type error",
  test: "This looks like a failing test",
  build: "This looks like a build or install error",
  infra: "This looks like a runner or service problem",
  config: "This looks like a problem with the workflow setup",
};

const RERUN = {
  passes: " Running it again will probably pass.",
  fails: " Running it again probably won't help.",
};

/** The model's read on the failure, in one sentence. */
function CauseNote({ cause }: { cause: FailureCause }) {
  const rerun = cause.rerun ? RERUN[cause.rerun] : "";
  return (
    <p className="text-sm text-muted-foreground">
      {CAUSES[cause.kind]}.{rerun}
    </p>
  );
}

/** Why the log isn't here, with the job's own output on GitHub one click away. */
function ProblemNote({
  problem,
  logUrl,
  onRetry,
}: {
  problem: Problem;
  logUrl: string;
  onRetry?: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2.5 text-sm"
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 text-muted-foreground">{problem.text}</span>
      <span className="flex items-center gap-1">
        {problem.retry && onRetry && (
          <Button variant="ghost" size="xs" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button variant="outline" size="xs" asChild>
          <a href={logUrl} target="_blank" rel="noreferrer">
            View the log on GitHub
            <ExternalLinkIcon aria-hidden />
          </a>
        </Button>
      </span>
    </div>
  );
}

/** Just the log's error lines, in red, with the whole excerpt behind a toggle. */
function CompactLog({ lines, errors }: { lines: string[]; errors: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid gap-1.5">
      <LogLines lines={open ? lines : errors} />
      <Button
        variant="ghost"
        size="xs"
        className="justify-self-start"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <ChevronDownIcon aria-hidden className={cn("transition-transform", open && "rotate-180")} />
        {open ? "Show only the errors" : `Show the log (${plural(lines.length, "line")})`}
      </Button>
    </div>
  );
}

// GitHub's workflow commands at the start of a log line.
const COMMAND = /^##\[(group|endgroup|error|warning|notice|debug)\]/;

/** The excerpt as GitHub shows it: group markers as plain lines, errors and warnings tinted. */
function LogLines({ lines }: { lines: string[] }) {
  return (
    <pre className="max-h-96 overflow-auto rounded-lg border bg-secondary/40 px-3 py-2 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const command = line.match(COMMAND)?.[1];
        if (command === "endgroup") return null;
        const text = command ? line.slice(command.length + 4) : line;
        return (
          <div
            key={index}
            className={cn(
              "min-h-5 whitespace-pre-wrap break-words",
              command === "error" && "text-destructive",
              command === "warning" && "text-run",
              command === "group" && "font-medium",
            )}
          >
            {text}
          </div>
        );
      })}
    </pre>
  );
}
