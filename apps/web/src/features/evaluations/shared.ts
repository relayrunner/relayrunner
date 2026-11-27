// Small helpers the evaluation steps and results share.
import { useEffect, useState } from "react";
import { errorText } from "@/lib/api";

// How often a running evaluation, and the setup's checks, look again.
const POLL_MS = 10_000;

/** Calls `load` now and every POLL_MS while `polling`, keeping the last answer. */
export function usePolled<T>(load: () => Promise<T>, polling: boolean, deps: unknown[]) {
  // Undefined until the first answer, since null can be an answer.
  const [value, setValue] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const run = () =>
      load().then(
        (next) => live && (setValue(next), setError(null)),
        (caught) => live && setError(errorText(caught)),
      );
    void run();
    const timer = polling ? setInterval(run, POLL_MS) : undefined;
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, ...deps]);
  return { value, error };
}

export const workflowFile = (path: string) => path.split("/").pop() ?? path;

/** "25 min", "1 h 5 min" or "under a minute": a run's or an evaluation's length, for "about …". */
export function about(ms: number) {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  const h = Math.floor(minutes / 60);
  return h ? `${h} h${minutes % 60 ? ` ${minutes % 60} min` : ""}` : `${minutes} min`;
}
