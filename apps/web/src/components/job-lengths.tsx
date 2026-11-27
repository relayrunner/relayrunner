import { TipRow } from "@/components/chart-parts";
import { Histogram } from "@/components/histogram";
import type { UsageReport } from "@/lib/usage";
import { count, percent } from "@/lib/utils";

/** "45s" or "12m": a bucket edge on the axis. */
const edge = (seconds: number) => (seconds < 60 ? `${seconds}s` : `${seconds / 60}m`);

/** "<10s", "10–30s", "30s–1m", "30m+": the jobs from `from` seconds up to `under`. */
function bucketLabel(from: number, under: number | null) {
  if (under === null) return `${edge(from)}+`;
  if (!from) return `<${edge(under)}`;
  const sameUnit = from < 60 === under < 60;
  return sameUnit ? `${edge(from).slice(0, -1)}–${edge(under)}` : `${edge(from)}–${edge(under)}`;
}

/** The average job's run time: "42s" under a minute, "3.2 min" above. */
function average(seconds: number) {
  return seconds < 60
    ? `${Math.round(seconds)}s`
    : `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} min`;
}

/**
 * Usage › Overview's jobs by how long they ran, the ones under a minute (each billed a whole
 * minute) in their own colour.
 */
export function JobLengths({ report }: { report: UsageReport }) {
  const { lengths, totals, shortJobSeconds } = report;
  const counted = lengths.reduce((sum, bucket) => sum + bucket.jobs, 0);
  if (!counted) return null;
  const bars = lengths.map(({ under, jobs }, i) => {
    const from = lengths[i - 1]?.under ?? 0;
    const label = bucketLabel(from, under);
    const short = under !== null && under <= shortJobSeconds;
    return {
      label,
      value: jobs,
      color: short ? "var(--rr-run)" : "var(--rr-idle)",
      tip: (
        <>
          <p className="font-medium">{label.replace(/m\b/g, " min")}</p>
          <TipRow label="Jobs" value={count(jobs)} />
          <TipRow label="Share of jobs" value={percent(jobs / counted)} />
          {short && <TipRow label="Billed" value="1 min each" />}
        </>
      ),
    };
  });
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4 sm:p-5">
      <div>
        <h2 className="text-sm font-semibold">How long jobs ran</h2>
        <p className="text-sm text-muted-foreground">
          The average job ran {average(totals.runSeconds / Math.max(totals.jobs, 1))}. Jobs under a
          minute still bill a whole one.
          {counted < totals.jobs && " Lengths cover the last 62 days."}
        </p>
      </div>
      <Histogram label="Jobs by how long they ran" bars={bars} />
    </section>
  );
}
