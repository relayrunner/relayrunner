import { AppError } from "@relayrunner/errors";
import { CatchBoundary } from "@tanstack/react-router";
import { ExternalLinkIcon, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type FailureCause, getJobFailure, type JobFailure } from "@/lib/runs";
import { cn } from "@/lib/utils";

// A failed job's failure doesn't change, so the last ones read are kept.
const cache = new Map<number, JobFailure>();
const CACHE_SIZE = 50;

function fetchFailure(jobId: number) {
  return getJobFailure(jobId).then((failure) => {
    cache.set(jobId, failure);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return failure;
  });
}

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
export function JobFailureSection({ jobId, logUrl }: { jobId: number; logUrl: string }) {
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
        <FailureDetail jobId={jobId} logUrl={logUrl} />
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

function FailureDetail({ jobId, logUrl }: { jobId: number; logUrl: string }) {
  // Undefined while loading.
  const [failure, setFailure] = useState<JobFailure | undefined>(() => cache.get(jobId));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (cache.has(jobId)) return;
    let live = true;
    fetchFailure(jobId)
      .then((value) => live && setFailure(value))
      .catch((caught: unknown) => live && setProblem(problemOf(caught)));
    return () => {
      live = false;
    };
  }, [jobId, attempt]);

  const retry = () => {
    setProblem(null);
    setAttempt((value) => value + 1);
  };

  return (
    <>
      <Heading failure={failure} />
      {problem ? (
        <ProblemNote problem={problem} logUrl={logUrl} onRetry={retry} />
      ) : failure === undefined ? (
        <div aria-busy aria-label="Loading the log" className="h-32 rounded-lg border" />
      ) : (
        <>
          {failure.cause && <CauseNote cause={failure.cause} />}
          {failure.runnerFailed && (
            <p className="text-sm">The runner failed the job before any step ran.</p>
          )}
          {failure.annotations.length > 0 && (
            <ul className="grid gap-1 text-sm">
              {failure.annotations.map((message, index) => (
                <li key={index} className="break-words">
                  {message}
                </li>
              ))}
            </ul>
          )}
          {failure.log === null ? (
            <p className="text-sm text-muted-foreground">GitHub no longer has this job's log.</p>
          ) : failure.log.length > 0 ? (
            <LogLines lines={failure.log} />
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
