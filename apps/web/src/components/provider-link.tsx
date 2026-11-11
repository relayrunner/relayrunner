import { PROVIDERS as PROVIDER_INFO } from "@relayrunner/providers";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type Provider, ProviderMark } from "@/components/providers";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";

/**
 * Where a provider is named inline (a mark in a table, a runner in a feed), this makes it a link
 * to the provider's page, with a card on hover saying what it is. Self-hosted machines have no
 * provider page, so theirs stay plain text.
 */
export function ProviderLink({
  provider,
  className,
  children,
}: {
  provider: Provider;
  className?: string;
  children: ReactNode;
}) {
  if (provider === "machine") return <span className={className}>{children}</span>;
  const { name, summary, labels } = PROVIDER_INFO[provider];
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link
          to="/providers/$provider"
          params={{ provider }}
          className={cn("hover:underline hover:underline-offset-2", className)}
        >
          {children}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex items-center gap-2.5">
          <ProviderMark provider={provider} className="size-6 rounded-md" />
          <span className="font-semibold">{name}</span>
        </div>
        <p className="mt-2 text-muted-foreground">{summary}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          Labels: <code className="font-mono">{labels}</code>
        </p>
        <Link
          to="/providers/$provider"
          params={{ provider }}
          className="mt-3 inline-block text-xs font-medium hover:underline"
        >
          Your usage on {name} →
        </Link>
      </HoverCardContent>
    </HoverCard>
  );
}
