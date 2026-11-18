import { Link } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { LEGAL_LINKS } from "@/lib/legal";
import { cn } from "@/lib/utils";

export const DOCS_URL = "https://relayrunner.dev/docs";
const X_URL = "https://x.com/relayrunnerCI";

// The same links as the landing site's footer. The agents link comes first.
const LINKS = [
  { label: "Docs", href: DOCS_URL },
  { label: "GitHub", href: "https://github.com/relayrunner/relayrunner" },
  { label: "GitHub App", href: "https://github.com/apps/relayrunner" },
  { label: "npm", href: "https://www.npmjs.com/package/relayrunner" },
  { label: "Privacy", href: LEGAL_LINKS.privacy.href },
  { label: "Terms", href: LEGAL_LINKS.terms.href },
];

const LINK_CLASS = "text-muted-foreground transition-colors hover:text-foreground";

/** The footer under every dashboard page: the mark, then how to connect an agent, the project and legal links, and X. */
export function SiteFooter({ className }: { className?: string }) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-t border-line-soft bg-background px-4 py-2.5 text-[13px] sm:px-8",
        className,
      )}
    >
      <Brand className="gap-2 text-sm text-ink-2 max-sm:hidden [&_img]:size-5" />
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
        <li className="flex items-center">
          <a href={X_URL} aria-label="RelayRunner on X" title="X" className={LINK_CLASS}>
            <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 fill-current">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
          </a>
        </li>
      </ul>
    </footer>
  );
}
