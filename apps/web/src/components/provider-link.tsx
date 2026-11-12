import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { type Provider, ProviderMark } from "@/components/providers";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

/**
 * A provider's mark and whatever names it inline (a runner in a table, a feed or a run), as a link
 * to the provider's page with a card on hover saying what it is. Self-hosted machines have no
 * provider page, so theirs stay plain.
 */
export function ProviderLink({
  provider,
  className,
  markClassName,
  children,
}: {
  provider: Provider;
  className?: string;
  markClassName?: string;
  children: ReactNode;
}) {
  const content = (
    <>
      <ProviderMark provider={provider} className={markClassName} />
      {children}
    </>
  );
  if (provider === "machine") return <span className={className}>{content}</span>;
  const { name, summary, labels } = providerInfo(provider);
  return (
    <HoverCard>
      <HoverCardTrigger asChild>
        <Link
          to="/providers/$provider"
          params={{ provider }}
          className={cn("hover:underline hover:underline-offset-2", className)}
        >
          {content}
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
