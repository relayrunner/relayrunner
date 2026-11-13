import type { SupportedLanguages } from "@pierre/diffs";
import { lazy, Suspense } from "react";

import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Highlighting pulls in Shiki, so load it only on pages that show code.
const File = lazy(() => import("@pierre/diffs/react").then((m) => ({ default: m.File })));

/**
 * Wrapped lines hang 4ch past their own indent, so nested code (like YAML) still reads.
 * The rules go inside the component's shadow root, one per indented line.
 */
function hangingIndent(code: string) {
  return code
    .split("\n")
    .map((line, index) => {
      const hang = line.length - line.trimStart().length + 4;
      return `[data-line="${index + 1}"]{padding-left:${hang}ch;text-indent:-${hang}ch}`;
    })
    .join("");
}

/** Highlighted, read-only code that follows the dashboard's light or dark theme. */
export function CodeBlock({
  code,
  lang,
  wrap = false,
  fontSize = 13,
  className,
}: {
  code: string;
  lang: SupportedLanguages;
  /** Wrap long lines instead of scrolling sideways. */
  wrap?: boolean;
  fontSize?: number;
  className?: string;
}) {
  const theme = useTheme();
  // Match the dashboard's code well instead of the theme's own background and font.
  const style = {
    "--diffs-font-family": "var(--font-mono)",
    "--diffs-font-size": `${fontSize}px`,
    "--diffs-line-height": `${Math.round(fontSize * 1.6)}px`,
    "--diffs-bg-context-override": "var(--rr-bg-deep)",
    "--diffs-bg-buffer-override": "var(--rr-bg-deep)",
    fontSize,
  } as React.CSSProperties;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-md border border-border/60 bg-[var(--rr-bg-deep)] font-mono leading-relaxed",
        className,
      )}
      style={style}
    >
      <Suspense
        fallback={
          <pre
            className={cn(
              "px-3 py-2.5 text-[var(--rr-ink-2)]",
              wrap ? "whitespace-pre-wrap [overflow-wrap:anywhere]" : "overflow-x-auto",
            )}
          >
            {code}
          </pre>
        }
      >
        <File
          file={{ name: `snippet.${lang}`, contents: code, lang }}
          options={{
            themeType: theme,
            disableFileHeader: true,
            disableLineNumbers: true,
            overflow: wrap ? "wrap" : "scroll",
            unsafeCSS: wrap ? hangingIndent(code) : undefined,
          }}
        />
      </Suspense>
    </div>
  );
}
