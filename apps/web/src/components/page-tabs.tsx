import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export type Tab<V extends string> = { value: V; label: string };

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
    <nav aria-label="Views" className="-mt-2 mb-6 flex gap-5 overflow-x-auto border-b">
      {tabs.map((tab, index) => {
        const active = tab.value === value;
        return (
          <Link
            key={tab.value}
            to="."
            search={{ view: index === 0 ? undefined : tab.value } as never}
            aria-current={active ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 pb-2 text-sm whitespace-nowrap transition-colors",
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
