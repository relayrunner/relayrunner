import { AppError } from "@relayrunner/errors";
import { useEffect, useState } from "react";
import { authDisabled } from "@/lib/auth-client";
import { getJobFailure, type JobFailure, sampleJobFailure } from "@/lib/runs";
import { cn } from "@/lib/utils";

// A failed job's failure doesn't change, so the last ones read are kept.
const cache = new Map<number, JobFailure>();
const CACHE_SIZE = 50;

function fetchFailure(jobId: number) {
  const request = authDisabled ? Promise.resolve(sampleJobFailure()) : getJobFailure(jobId);
  return request.then((failure) => {
    cache.set(jobId, failure);
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
    return failure;
  });
}

function problemText(caught: unknown) {
  const code = caught instanceof AppError ? caught.code : null;
  if (code === "FORBIDDEN") return "Only people who can read this repo on GitHub can see its log.";
  if (code === "GITHUB_RATE_LIMITED")
    return "GitHub's API is busy for this account. Try again in a few minutes.";
  return "Couldn't load the log from GitHub.";
}

/**
 * Why a failed job failed, in its History panel: the step that broke, GitHub's annotations and the
 * end of its log up to the last error. Read from GitHub when the panel opens; never stored.
 */
export function JobFailureSection({ jobId }: { jobId: number }) {
  // Undefined while loading.
  const [failure, setFailure] = useState<JobFailure | undefined>(() => cache.get(jobId));
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    if (cache.has(jobId)) return;
    let live = true;
    fetchFailure(jobId)
      .then((value) => live && setFailure(value))
      .catch((caught: unknown) => live && setProblem(problemText(caught)));
    return () => {
      live = false;
    };
  }, [jobId]);

  return (
    <section className="grid gap-2">
      <h3 className="text-sm font-medium">
        {failure?.failedStep
          ? `Failed at step ${failure.failedStep.replace(/^(\d+)\. /, "$1: ")}`
          : "Why it failed"}
      </h3>
      {problem ? (
        <p className="text-sm text-muted-foreground">{problem}</p>
      ) : failure === undefined ? (
        <div aria-busy aria-label="Loading the log" className="h-32 rounded-lg border" />
      ) : (
        <>
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
          ) : (
            failure.log.length > 0 && <LogLines lines={failure.log} />
          )}
        </>
      )}
    </section>
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
