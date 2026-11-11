// On/off choices kept per browser, such as a collapsed sidebar. Storage can be blocked, in which
// case a choice reads as off and just won't outlast the tab.

export function readFlag(key: string) {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function saveFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Blocked: see above.
  }
}
