import { CircleHelpIcon, CloudIcon, LaptopIcon } from "lucide-react";
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
import { cn } from "@/lib/utils";

// Where a job ran, by its environment key: `depot:<label>` and the like for hosted runner services,
// plain `container` for the Cloudflare Container, and `machine:<id>` or `self-hosted:<group>` for
// runners people host themselves.
export type Provider =
  | "blacksmith"
  | "depot"
  | "namespace"
  | "warpbuild"
  | "ubicloud"
  | "runs-on"
  | "github"
  | "cloudflare"
  | "machine"
  | "other";

export type ProviderStyle = {
  name: string;
  icon: ReactNode;
  /** Brand tile behind the mark, header tint and share-bar colour. */
  tile: string;
  tint: string;
  bar: string;
  /** Dropped from each runner's label, since the card already names the provider. */
  prefix?: RegExp;
  /** Labels are runs-on labels, so monospace; GitHub classes and the container type are names. */
  mono?: boolean;
  /** The provider's dashboard (or docs, where there is none), opened from its tile. */
  url?: string;
  /** Show the environment's detail beside each runner (machine size, runner group). */
  detail?: boolean;
};

export const PROVIDERS: Record<Provider, ProviderStyle> = {
  blacksmith: {
    name: "Blacksmith",
    url: "https://app.blacksmith.sh",
    icon: <BlacksmithIcon className="w-4" />,
    tile: "bg-blacksmith text-blacksmith-ink",
    tint: "bg-blacksmith/8",
    bar: "bg-blacksmith-ink dark:bg-blacksmith",
    prefix: /^blacksmith-/,
    mono: true,
  },
  depot: {
    name: "Depot",
    url: "https://depot.dev/orgs",
    icon: <DepotIcon className="size-3.5" />,
    tile: "bg-foreground text-background",
    tint: "bg-foreground/4",
    bar: "bg-ink-2",
    prefix: /^depot-/,
    mono: true,
  },
  namespace: {
    name: "Namespace",
    url: "https://cloud.namespace.so",
    icon: <NamespaceIcon className="size-5" />,
    tile: "bg-namespace text-white",
    tint: "bg-namespace/10",
    bar: "bg-namespace",
    prefix: /^(namespace-|nscloud-)/,
    mono: true,
  },
  warpbuild: {
    name: "WarpBuild",
    url: "https://app.warpbuild.com",
    icon: <WarpBuildIcon className="w-4" />,
    tile: "bg-raised-2 text-warpbuild",
    tint: "bg-warpbuild/8",
    bar: "bg-warpbuild",
    prefix: /^warp-/,
    mono: true,
  },
  ubicloud: {
    name: "Ubicloud",
    url: "https://console.ubicloud.com",
    icon: <CloudIcon aria-hidden className="size-4" strokeWidth={2.25} />,
    tile: "bg-ubicloud text-white",
    tint: "bg-ubicloud/8",
    bar: "bg-ubicloud",
    prefix: /^ubicloud-/,
    mono: true,
  },
  "runs-on": {
    name: "RunsOn",
    url: "https://runs-on.com/docs/",
    icon: <span className="font-serif text-base leading-none font-bold">r</span>,
    tile: "bg-[#101010] text-runson",
    tint: "bg-runson/8",
    bar: "bg-runson",
    mono: true,
  },
  github: {
    name: "GitHub",
    url: "https://docs.github.com/en/actions/reference/runners/github-hosted-runners",
    icon: <GithubIcon className="size-4" />,
    tile: "bg-foreground text-background",
    tint: "bg-foreground/4",
    bar: "bg-ink-2",
  },
  cloudflare: {
    name: "Cloudflare",
    url: "https://dash.cloudflare.com",
    icon: <CloudflareIcon className="size-[18px]" />,
    tile: "bg-raised-2 text-cloudflare",
    tint: "bg-cloudflare/8",
    bar: "bg-cloudflare",
    prefix: /^Cloudflare /,
    detail: true,
  },
  machine: {
    name: "Self-hosted",
    icon: <LaptopIcon aria-hidden className="size-4" />,
    tile: "bg-raised-2 text-foreground",
    tint: "",
    bar: "bg-ink-2",
  },
  other: {
    name: "Other",
    icon: <CircleHelpIcon aria-hidden className="size-4" />,
    tile: "bg-raised-2 text-muted-foreground",
    tint: "",
    bar: "bg-ink-2",
    mono: true,
    detail: true,
  },
};

export const TILE = "flex size-7 shrink-0 items-center justify-center rounded-md";

export function providerOf({ key }: Pick<Environment, "key">): Provider {
  if (key === "container") return "cloudflare";
  if (key.startsWith("machine:") || key.startsWith("self-hosted:")) return "machine";
  const id = key.slice(0, key.indexOf(":"));
  return id in PROVIDERS ? (id as Provider) : "other";
}

/**
 * A provider's mark on its brand tile, shrunk to sit inline in a row or a table cell. The tile
 * colours are the ones the Runners page cards use, so a provider looks the same everywhere.
 */
export function ProviderMark({ provider, className }: { provider: Provider; className?: string }) {
  const { icon, tile } = PROVIDERS[provider];
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
  const { prefix } = PROVIDERS[provider];
  return prefix ? label.replace(prefix, "") : label;
}
