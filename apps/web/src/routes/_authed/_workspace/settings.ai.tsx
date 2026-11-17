import { createFileRoute } from "@tanstack/react-router";
import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { DOCS_URL } from "@/components/site-footer";
import { Card, CardContent } from "@/components/ui/card";
import { getAiOptIn, setAiOptIn } from "@/lib/ai";
import { errorText } from "@/lib/api";
import { canManage } from "@/lib/roles";
import { formatDate } from "@/lib/time-zone";

export const Route = createFileRoute("/_authed/_workspace/settings/ai")({
  loader: ({ context }) => getAiOptIn(context.current.workspace.id),
  component: AiSettingsPage,
});

function AiSettingsPage() {
  const { current } = Route.useRouteContext();
  const loaded = Route.useLoaderData();
  const [since, setSince] = useState(loaded.since);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const manager = canManage(current.role);

  async function toggle(next: boolean) {
    const before = since;
    setSince(next ? new Date().toISOString() : null);
    setPending(true);
    setError(null);
    try {
      await setAiOptIn(current.workspace.id, next);
    } catch (caught) {
      setSince(before);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <PageHeader title="AI">
        AI reads your failed jobs and job names to tell you why jobs fail and what each one does.
        It's off until an owner or admin turns it on.{" "}
        <a
          href={`${DOCS_URL}/dashboard/ai`}
          className="inline-flex items-center gap-0.5 text-go hover:text-go-hover"
        >
          What AI reads
          <ArrowUpRightIcon aria-hidden className="size-3" />
        </a>
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <Card className="py-4">
          <CardContent className="grid gap-3 px-4 text-sm">
            <label className="flex cursor-pointer gap-3">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-go)]"
                checked={since !== null}
                disabled={!manager || pending}
                onChange={(e) => toggle(e.target.checked)}
              />
              <span className="grid gap-0.5">
                <span className="font-medium">Use AI in this workspace</span>
                <span className="text-muted-foreground">
                  {since ? `On since ${formatDate(since)}.` : "Off."}
                  {!manager && " An owner or admin can change this."}
                </span>
                {error && <span className="text-destructive">{error}</span>}
              </span>
            </label>
            {loaded.features.length > 0 ? (
              <ul className="ml-7 grid list-disc gap-1 pl-4 text-muted-foreground">
                {loaded.features.map((feature) => (
                  <li key={feature.id}>{feature.label}</li>
                ))}
              </ul>
            ) : (
              <p className="ml-7 text-muted-foreground">
                AI features aren't available yet. Turn this on and they start when they are.
              </p>
            )}
          </CardContent>
        </Card>
        <div className="grid gap-2 text-sm">
          <h2 className="font-medium">What AI reads</h2>
          <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
            <li>Workflow, job and step names, and runner labels.</li>
            <li>
              For a failed job, the last 30 lines of its log and GitHub's error annotations. GitHub
              hides secrets in logs before we read them.
            </li>
          </ul>
          <p className="text-muted-foreground">
            The model runs on Cloudflare, which keeps nothing and trains on nothing. We keep only
            the answer, such as "flaky test". Your code never goes to AI.
          </p>
        </div>
      </div>
    </section>
  );
}
