import { ArrowUpRightIcon } from "lucide-react";
import { useState } from "react";
import { DOCS_URL } from "@/components/site-footer";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { setAiOptIn } from "@/lib/ai";
import { errorText } from "@/lib/api";
import { formatDate } from "@/lib/time-zone";

/** The workspace's AI switch, on Settings › General. Owners and admins can change it. */
export function AiOptInCard({
  workspaceId,
  since: loaded,
  manager,
}: {
  workspaceId: string;
  since: string | null;
  manager: boolean;
}) {
  const [since, setSince] = useState(loaded);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle(next: boolean) {
    const before = since;
    setSince(next ? new Date().toISOString() : null);
    setPending(true);
    setError(null);
    try {
      await setAiOptIn(workspaceId, next);
    } catch (caught) {
      setSince(before);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">AI</CardTitle>
      </CardHeader>
      <CardContent className="px-4 text-sm">
        <label className="flex cursor-pointer gap-3">
          <input
            type="checkbox"
            className="mt-0.5 size-4 accent-[var(--color-go)]"
            checked={since !== null}
            disabled={!manager || pending}
            onChange={(e) => toggle(e.target.checked)}
          />
          <span className="grid gap-0.5">
            <span className="font-medium">
              Use AI in this workspace
              <span className="font-normal text-muted-foreground">
                {since ? ` · On since ${formatDate(since)}` : ""}
              </span>
            </span>
            <span className="text-muted-foreground">
              AI reads job names and the end of failed jobs' logs to tell you why jobs fail and what
              each one does. The model runs on Cloudflare, which keeps nothing and trains on
              nothing.{" "}
              <a
                href={`${DOCS_URL}/dashboard/ai`}
                className="inline-flex items-center gap-0.5 text-go hover:text-go-hover"
              >
                What AI reads
                <ArrowUpRightIcon aria-hidden className="size-3" />
              </a>
            </span>
            {!manager && (
              <span className="text-muted-foreground">An owner or admin can change this.</span>
            )}
            {error && <span className="text-destructive">{error}</span>}
          </span>
        </label>
      </CardContent>
    </Card>
  );
}
