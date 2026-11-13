import type { SupportedLanguages } from "@pierre/diffs";
import { lazy, Suspense } from "react";

import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

// Highlighting pulls in Shiki, so load it only on pages that show code.
const File = lazy(() => import("@pierre/diffs/react").then((m) => ({ default: m.File })));

// Use the dashboard's code-well background instead of the theme's, and give the code room
// from the frame's edges.
const BASE_CSS =
  ":host{--diffs-light-bg:var(--rr-bg-deep);--diffs-dark-bg:var(--rr-bg-deep)}" +
  "[data-code]{padding:10px 12px}";

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
  // Match the dashboard's mono font and sizes.
  const style = {
    "--diffs-font-family": "var(--font-mono)",
    "--diffs-font-size": `${fontSize}px`,
    "--diffs-line-height": `${Math.round(fontSize * 1.6)}px`,
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
            unsafeCSS: BASE_CSS + (wrap ? hangingIndent(code) : ""),
          }}
        />
      </Suspense>
    </div>
  );
}
