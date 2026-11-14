import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * A search updater that opens a runner's panel at its default range, or with no runner closes it.
 */
export const withRunner = (runner?: string) =>
  ((prev: Record<string, unknown>) => ({ ...prev, runner, runnerRange: undefined })) as never;

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
  return <Link to="." search={withRunner(runner)} preload={false} {...props} />;
}
