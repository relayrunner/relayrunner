import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * A link that opens a runner's panel over the page it's on. The panel is a search change
 * (`?runner=`), so there's nothing to preload.
 */
export function RunnerPanelLink({
  runner,
  ...props
}: { runner: string } & Omit<LinkProps, "to" | "from" | "search"> & {
    className?: string;
    children?: ReactNode;
    title?: string;
  }) {
  return (
    <Link
      to="."
      search={((prev: Record<string, unknown>) => ({ ...prev, runner })) as never}
      preload={false}
      {...props}
    />
  );
}
