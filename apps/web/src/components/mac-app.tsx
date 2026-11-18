import { DownloadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The site's download page: it picks the Mac app or the CLI for the visitor's computer. */
export const DOWNLOAD_URL = "https://relayrunner.dev/download";

/**
 * Whether this browser is on a Mac, where the dashboard offers the Mac app ahead of the CLI. iPads
 * also say "Macintosh", so a touch screen counts as not a Mac.
 */
export const ON_MAC =
  typeof navigator !== "undefined" &&
  /Macintosh/.test(navigator.userAgent) &&
  navigator.maxTouchPoints < 2;

/** A button to the Mac app's download, for Mac browsers. */
export function MacAppButton({ size = "sm" }: { size?: "sm" | "default" }) {
  return (
    <Button asChild size={size}>
      <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer">
        <DownloadIcon aria-hidden />
        Download for Mac
      </a>
    </Button>
  );
}

/** A quiet link to the Mac app, for everywhere else. */
export function MacAppLink({ className }: { className?: string }) {
  return (
    <a
      href={DOWNLOAD_URL}
      target="_blank"
      rel="noreferrer"
      className={className ?? "underline underline-offset-2 hover:text-foreground"}
    >
      Get the Mac app
    </a>
  );
}
