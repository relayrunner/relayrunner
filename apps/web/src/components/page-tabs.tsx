import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export type Tab<V extends string> = { value: V; label: string };

// The pages with tabs. The sidebar lists these under each page's name, so keep them here and not in
// the route files, which load on their own.
export const HISTORY_TABS = [
  { value: "workflows", label: "Workflows" },
  { value: "jobs", label: "Jobs" },
] as const satisfies Tab<string>[];

// An old link's `?view=jobs` lands on Workflows, whose rows open each workflow's jobs.
export const PERFORMANCE_TABS = [
  { value: "workflows", label: "Workflows" },
  { value: "runners", label: "Runners" },
  { value: "types", label: "Job types" },
] as const satisfies Tab<string>[];

/** `?view=` from the URL when it names one of the page's tabs. The first tab is the default. */
export function viewOf<V extends string>(tabs: readonly Tab<V>[], value: unknown): V | undefined {
  return tabs.slice(1).find((tab) => tab.value === value)?.value;
}

/**
 * A page's views as a row of tabs. Each is a link to the same page with `?view=` set, so a view can
 * be linked to and the back button steps through them. The first tab leaves `view` out.
 */
export function PageTabs<V extends string>({ tabs, value }: { tabs: readonly Tab<V>[]; value: V }) {
  return (
    // The rule is an inset shadow, not a border, so the active tab's underline can sit on it
    // without overflowing: overflow-x-auto would make the row scroll vertically by that pixel.
    <nav
      aria-label="Views"
      className="-mt-2 mb-8 flex gap-5 overflow-x-auto shadow-[inset_0_-1px_0_var(--color-border)]"
    >
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <Link
            key={tab.value}
            to="."
            search={{ view: index === 0 ? undefined : tab.value } as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "border-b-2 pb-2 text-sm whitespace-nowrap transition-colors",
              active
                ? "border-foreground font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
