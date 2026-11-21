import { Link, type LinkProps } from "@tanstack/react-router";
import { CLOSED_PANELS } from "@/lib/panels";
import { cn } from "@/lib/utils";
import { type WorkflowRef, workflowParam } from "@/lib/workflow-ref";

/** A search updater that opens a workflow's panel at its default range, or with none closes it. */
export const withWorkflow = (ref?: WorkflowRef) =>
  ((prev: Record<string, unknown>) => ({
    ...prev,
    ...CLOSED_PANELS,
    wf: ref && workflowParam(ref),
  })) as never;

/**
 * A workflow's name, opening its panel (components/workflow-sheet.tsx) over the page it's on. The
 * panel is a search change, so there's nothing to preload. A run GitHub didn't name a workflow for
 * shows `fallback` as plain text.
 */
export function WorkflowLink({
  repository,
  workflow,
  fallback = "Unnamed workflow",
  className,
  ...props
}: { repository: string; workflow: string | null; fallback?: string } & Omit<
  LinkProps,
  "to" | "from" | "search" | "children"
> & { className?: string }) {
  if (!workflow) return <span className={className}>{fallback}</span>;
  return (
    <Link
      to="."
      search={withWorkflow({ repository, workflow })}
      preload={false}
      resetScroll={false}
      className={cn("hover:underline hover:underline-offset-2", className)}
      {...props}
    >
      {workflow}
    </Link>
  );
}
