import { CircleHelpIcon, CloudIcon, LaptopIcon } from "lucide-react";
import { type ProviderId, providerOfEnvironment } from "@relayrunner/providers";
import type { ReactNode } from "react";
import {
  BlacksmithIcon,
  CloudflareIcon,
  DepotIcon,
  GithubIcon,
  NamespaceIcon,
  WarpBuildIcon,
} from "@/components/provider-logos";
import type { Environment } from "@/lib/job-times";
import { isKnownProvider, providerInfo } from "@/lib/provider-catalog";
import { cn } from "@/lib/utils";

// Where a job ran: a provider's id (one in code or one operators added), or "machine" for runners
// people host themselves. The catalog holds names and links; this file adds each one's mark and
// colours.
export type Provider = string;

type ProviderLook = {
  icon: ReactNode;
  /** Brand tile behind the mark, header tint and share-bar colour. */
  tile: string;
  tint: string;
  bar: string;
  /** Dropped from each runner's label, since the card already names the provider. */
  prefix?: RegExp;
  /** Labels are runs-on labels, so monospace; GitHub classes and the container type are names. */
  mono?: boolean;
  /** Show the environment's detail beside each runner (machine size, runner group). */
  detail?: boolean;
};

export type ProviderStyle = ProviderLook & {
  name: string;
  /** The provider's dashboard (or docs, where there is none), opened from its tile. */
  url?: string;
};

const LOOKS: Record<ProviderId | "machine", ProviderLook> = {
  blacksmith: {
    icon: <BlacksmithIcon className="w-4" />,
    tile: "bg-blacksmith text-blacksmith-ink",
    tint: "bg-blacksmith/8",
    bar: "bg-blacksmith-ink dark:bg-blacksmith",
    prefix: /^blacksmith-/,
    mono: true,
  },
  depot: {
    icon: <DepotIcon className="size-3.5" />,
    tile: "bg-foreground text-background",
    tint: "bg-foreground/4",
    bar: "bg-ink-2",
    prefix: /^depot-/,
    mono: true,
  },
  namespace: {
    icon: <NamespaceIcon className="size-5" />,
    tile: "bg-namespace text-white",
    tint: "bg-namespace/10",
    bar: "bg-namespace",
    prefix: /^(namespace-|nscloud-)/,
    mono: true,
  },
  warpbuild: {
    icon: <WarpBuildIcon className="w-4" />,
    tile: "bg-raised-2 text-warpbuild",
    tint: "bg-warpbuild/8",
    bar: "bg-warpbuild",
    prefix: /^warp-/,
    mono: true,
  },
  ubicloud: {
    icon: <CloudIcon aria-hidden className="size-4" strokeWidth={2.25} />,
    tile: "bg-ubicloud text-white",
    tint: "bg-ubicloud/8",
    bar: "bg-ubicloud",
    prefix: /^ubicloud-/,
    mono: true,
  },
  "runs-on": {
    icon: <span className="font-serif text-base leading-none font-bold">r</span>,
    tile: "bg-[#101010] text-runson",
    tint: "bg-runson/8",
    bar: "bg-runson",
    mono: true,
  },
  github: {
    icon: <GithubIcon className="size-4" />,
    tile: "bg-foreground text-background",
    tint: "bg-foreground/4",
    bar: "bg-ink-2",
  },
  cloudflare: {
    icon: <CloudflareIcon className="size-[18px]" />,
    tile: "bg-raised-2 text-cloudflare",
    tint: "bg-cloudflare/8",
    bar: "bg-cloudflare",
    prefix: /^Cloudflare /,
    detail: true,
  },
  machine: {
    icon: <LaptopIcon aria-hidden className="size-4" />,
    tile: "bg-raised-2 text-foreground",
    tint: "",
    bar: "bg-ink-2",
  },
  other: {
    icon: <CircleHelpIcon aria-hidden className="size-4" />,
    tile: "bg-raised-2 text-muted-foreground",
    tint: "",
    bar: "bg-ink-2",
    mono: true,
    detail: true,
  },
};

// A provider an operator added has no mark of its own yet: its initial on a plain tile.
const addedLook = (name: string): ProviderLook => ({
  icon: <span className="text-[13px] leading-none font-semibold">{name.charAt(0)}</span>,
  tile: "bg-raised-2 text-foreground",
  tint: "",
  bar: "bg-ink-2",
  mono: true,
});

/** A provider's mark, colours, name and link. */
export function providerStyle(provider: Provider): ProviderStyle {
  if (provider === "machine") return { ...LOOKS.machine, name: "Self-hosted" };
  const { id, name, dashboardUrl, docsUrl } = providerInfo(provider);
  const look = Object.hasOwn(LOOKS, id) ? LOOKS[id as ProviderId] : addedLook(name);
  return { ...look, name, url: dashboardUrl ?? docsUrl };
}

export const TILE = "flex size-7 shrink-0 items-center justify-center rounded-md";

export const providerOf = ({ key }: Pick<Environment, "key">): Provider =>
  providerOfEnvironment(key, isKnownProvider);

/**
 * A provider's mark on its brand tile, shrunk to sit inline in a row or a table cell. The tile
 * colours are the ones the Runners page cards use, so a provider looks the same everywhere.
 */
export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  const { icon, tile } = providerStyle(provider);
  return (
    <span
      aria-hidden
      className={cn(
        TILE,
        "size-5 rounded-[5px] [&_svg]:max-h-3 [&_svg]:max-w-3 [&>span]:text-[11px]",
        tile,
        className,
      )}
    >
      {icon}
    </span>
  );
}

/** A runner's label without its provider's prefix, since the provider is shown beside it. */
export function runnerName(provider: Provider, label: string) {
  const { prefix } = providerStyle(provider);
  return prefix ? label.replace(prefix, "") : label;
}
