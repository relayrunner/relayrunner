// The icon for a self-hosted runner: a server for runners added from GitHub (and runner groups),
// and for a `relayrunner connect` machine, its device when the CLI said what it is.
import {
  BoxIcon,
  CpuIcon,
  LaptopIcon,
  type LucideProps,
  MonitorIcon,
  PcCaseIcon,
  ServerIcon,
} from "lucide-react";
import type { ComponentType } from "react";
import type { DeviceKind } from "@/lib/device";
import { cn } from "@/lib/utils";

type Icon = ComponentType<LucideProps>;

/** A Mac mini or Mac Studio from the front: a low box on a narrower base. Drawn like lucide's. */
export function MacMiniIcon({ className, strokeWidth = 2, ...props }: LucideProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("lucide size-6", className)}
      {...props}
    >
      <rect x="3" y="7" width="18" height="9" rx="2.5" />
      <path d="M7 19.5h10" />
    </svg>
  );
}

const KIND_ICONS: Record<DeviceKind, Icon> = {
  laptop: LaptopIcon,
  desktop: MonitorIcon,
  server: ServerIcon,
  vm: BoxIcon,
  unknown: CpuIcon,
};

/** Runners added from GitHub and runner groups: stable machines someone runs as a server. */
export const SelfHostedIcon = ServerIcon;

/**
 * A connected machine's icon from what its CLI reported. The model picks between desktops (a Mac
 * mini isn't a monitor); anything unreported gets the generic chip.
 */
export function deviceIcon(device: { kind: DeviceKind | null; model: string | null } | null): Icon {
  const model = device?.model ?? "";
  if (/^Mac (mini|Studio)/.test(model)) return MacMiniIcon;
  if (model.startsWith("Mac Pro")) return PcCaseIcon;
  return KIND_ICONS[device?.kind ?? "unknown"] ?? CpuIcon;
}
