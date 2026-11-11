import { Link } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { cn } from "@/lib/utils";

// The same links as the landing site's footer, minus its guides. The agents link comes first.
const LINKS = [
  { label: "GitHub", href: "https://github.com/relayrunner/relayrunner" },
  { label: "npm", href: "https://www.npmjs.com/package/relayrunner" },
  { label: "Privacy", href: "https://relayrunner.app/privacy" },
  { label: "Terms", href: "https://relayrunner.app/terms" },
];

const LINK_CLASS = "text-muted-foreground transition-colors hover:text-foreground";

/** The footer under every dashboard page: the mark, then how to connect an agent, and the project and legal links. */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line-soft bg-background px-4 py-2.5 text-[13px] sm:px-8",
        className,
      )}
    >
      <Brand className="gap-2 text-sm text-ink-2 max-sm:hidden [&_svg]:size-[18px]" />
      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        <li>
          <Link to="/settings/agents" className={LINK_CLASS}>
            Use with agents
          </Link>
        </li>
        {LINKS.map(({ label, href }) => (
          <li key={label}>
            <a href={href} className={LINK_CLASS}>
              {label}
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
