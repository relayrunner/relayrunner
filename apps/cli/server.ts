// The gateway URL the CLI talks to, from --server, RELAYRUNNER_URL or the saved credentials.

import { RunnerError } from "./install.ts";

/** The URL's origin. Throws a USAGE RunnerError for anything but https, or http to localhost. */
export function normalizeServer(value: string) {
  let url: URL;
  try {
    url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
  } catch {
    throw new RunnerError("USAGE", `Not a valid RelayRunner URL: ${value}`);
  }
  if (!sendsTokenSafely(url))
    throw new RunnerError(
      "USAGE",
      `${url.origin} isn't https. RelayRunner only uses plain http for localhost, since the machine token is sent on every connect.`,
    );
  return url.origin;
}

/**
 * The machine token goes out on every connect, so plain http is only for a gateway on this
 * computer (local development). Credentials saved for any other http gateway aren't read either.
 */
export function sendsTokenSafely(url: URL) {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function isLoopback(hostname: string) {
  return hostname === "localhost" || hostname === "[::1]" || /^127(\.\d{1,3}){3}$/.test(hostname);
}
