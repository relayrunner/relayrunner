import { useSyncExternalStore } from "react";

/** What the user picked. "system" follows the OS and is the default. */
export type Theme = "system" | "light" | "dark";

// index.html reads the same key before first paint, so keep the two in sync.
const KEY = "rr-theme";
const query = () => window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function read(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply() {
  const theme = read();
  const dark = theme === "dark" || (theme === "system" && query().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Saves the pick for this browser and repaints. */
export function setTheme(theme: Theme) {
  try {
    if (theme === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch {
    // Storage blocked: the pick can't be saved.
  }
  apply();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Follow the OS while on "system", and picks made in other tabs.
  const onChange = () => {
    apply();
    listener();
  };
  const media = query();
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The current pick, updating when it changes. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "system");
}
