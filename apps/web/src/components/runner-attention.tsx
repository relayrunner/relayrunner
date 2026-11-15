import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";
import { useState } from "react";
import { CONNECT_COMMAND, CopyButton } from "@/components/add-runner";
import { githubRunnerUrl } from "@/components/runner-card";
import { RunnerPanelLink } from "@/components/runner-panel-link";
import { DOCS_URL } from "@/components/site-footer";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { AttentionFix, AttentionItem } from "@/lib/attention";
import { resumeMachine } from "@/lib/machines";

/**
 * The Runners page's "Needs attention" list: one row per thing that won't sort itself out, each
 * with what fixes it. Nothing at all when the list is empty.
 */
export function NeedsAttention({
  items,
  onAddRunner,
  onChanged,
}: {
  items: AttentionItem[];
  /** Opens the Add runners dialog; left out for members who can't add runners. */
  onAddRunner?: () => void;
  /** Called after a row's fix changed a machine, such as unpausing it. */
  onChanged: () => unknown;
}) {
  if (!items.length) return null;
  return (
    <section aria-label="Needs attention" className="grid content-start gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <TriangleAlertIcon aria-hidden className="size-4 text-run" />
        Needs attention
      </h2>
      <Card className="gap-0 divide-y divide-line-soft overflow-hidden py-0">
        {items.map((item) => (
          <div
            key={item.key}
            className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 text-sm"
          >
            <span className="min-w-0">{item.text}</span>
            <Fix fix={item.fix} onAddRunner={onAddRunner} onChanged={onChanged} />
          </div>
        ))}
      </Card>
    </section>
  );
}

function Fix({
  fix,
  onAddRunner,
  onChanged,
}: {
  fix: AttentionFix;
  onAddRunner?: () => void;
  onChanged: () => unknown;
}) {
  const [pending, setPending] = useState(false);
  const link = "text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground";
  switch (fix.kind) {
    case "unpause":
      return (
        <Button
          size="xs"
          variant="outline"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              await resumeMachine(fix.machine.id);
              await onChanged();
            } catch {
              // The row stays, so they can try again or use the card's menu.
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Unpausing…" : "Unpause"}
        </Button>
      );
    case "connect":
      // Started again on the machine itself.
      return (
        <span className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/50 py-0.5 pr-0.5 pl-2">
          <code className="truncate font-mono text-xs">{CONNECT_COMMAND}</code>
          <CopyButton text={CONNECT_COMMAND} label="Copy command" />
        </span>
      );
    case "github": {
      const href = githubRunnerUrl(fix.machine.github ?? null);
      return href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`${link} flex items-center gap-1`}
        >
          Open on GitHub
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </a>
      ) : null;
    }
    case "add-runner":
      return onAddRunner ? (
        <Button size="xs" variant="outline" onClick={onAddRunner}>
          Add runner
        </Button>
      ) : (
        <a href={`${DOCS_URL}/runners/self-hosted`} className={link}>
          Self-hosted runners
        </a>
      );
    case "runner":
      return (
        <RunnerPanelLink runner={`machine:${fix.machine.id}`} className={link}>
          Open {fix.machine.name}
        </RunnerPanelLink>
      );
  }
}
