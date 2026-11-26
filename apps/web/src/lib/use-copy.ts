import { useState } from "react";

/**
 * Copies `text` on `copy()`, or what it returns when it's a function, so the text can be worked
 * out only then; `copied` stays true for a moment after.
 */
export function useCopy(text: string | (() => string)) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be blocked (insecure origin, permissions); the text is still selectable.
    }
  }
  return { copied, copy };
}
