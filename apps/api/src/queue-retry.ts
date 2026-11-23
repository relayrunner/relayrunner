// A failed queue message's delay before its retry: 30s, 60s, 120s, ... capped at 15 minutes.
// `attempts` starts at 1.
export function retryDelaySeconds(attempts: number) {
  return Math.min(30 * 2 ** Math.max(0, attempts - 1), 15 * 60);
}
