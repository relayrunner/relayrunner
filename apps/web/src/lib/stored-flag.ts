// Choices kept per browser, such as a collapsed sidebar or a panel's width. Storage can be blocked,
// in which case a choice reads as unset and just won't outlast the tab.

export function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function saveFlag(key: string, on: boolean) {
  saveValue(key, on ? "1" : null);
}

export function readNumber(key: string) {
  try {
    const value = Number(localStorage.getItem(key) ?? NaN);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveNumber(key: string, value: number | null) {
  saveValue(key, value === null ? null : String(value));
}

function saveValue(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Blocked: see above.
  }
}
