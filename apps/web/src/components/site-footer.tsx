import { Link } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { DOWNLOAD_URL } from "@/components/mac-app";
import { LEGAL_LINKS } from "@/lib/legal";
import { cn } from "@/lib/utils";

export const DOCS_URL = "https://relayrunner.dev/docs";

// Project and legal links. The agents link comes first.
const LINKS = [
  { label: "Docs", href: DOCS_URL },
  { label: "Changelog", href: `${DOCS_URL}/changelog` },
  { label: "Download", href: DOWNLOAD_URL },
  { label: "GitHub App", href: "https://github.com/apps/relayrunner" },
  { label: "Privacy", href: LEGAL_LINKS.privacy.href },
  { label: "Terms", href: LEGAL_LINKS.terms.href },
];

// Shown as icons at the end of the row.
const SOCIAL = [
  {
    label: "GitHub",
    href: "https://github.com/relayrunner/relayrunner",
    path: "M12 .3a12 12 0 0 0-3.8 23.38c.6.12.83-.26.83-.57L9 21.07c-3.34.72-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76-1.08-.74.09-.73.09-.73 1.2.09 1.83 1.24 1.83 1.24 1.07 1.83 2.81 1.3 3.5 1 .1-.78.42-1.31.76-1.61-2.67-.3-5.47-1.33-5.47-5.93 0-1.31.47-2.38 1.24-3.22-.14-.3-.54-1.52.1-3.18 0 0 1-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.28-1.55 3.29-1.23 3.29-1.23.64 1.66.24 2.88.12 3.18a4.65 4.65 0 0 1 1.23 3.22c0 4.61-2.8 5.63-5.48 5.92.42.36.81 1.1.81 2.22l-.01 3.29c0 .31.2.69.82.57A12 12 0 0 0 12 .3",
  },
  {
    label: "X",
    href: "https://x.com/relayrunnerCI",
    path: "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z",
  },
];

const LINK_CLASS = "text-muted-foreground transition-colors hover:text-foreground";

/** The footer under every dashboard page: the mark, then how to connect an agent, the project and legal links, then GitHub and X. */
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
        {SOCIAL.map(({ label, href, path }) => (
          <li key={label} className="flex items-center">
            <a
              href={href}
              aria-label={`RelayRunner on ${label}`}
              title={label}
              className={LINK_CLASS}
            >
              <svg viewBox="0 0 24 24" aria-hidden className="size-3.5 fill-current">
                <path d={path} />
              </svg>
            </a>
          </li>
        ))}
      </ul>
    </footer>
  );
}
