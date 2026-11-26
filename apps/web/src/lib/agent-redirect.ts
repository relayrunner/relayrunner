// Where agent sign-in sends the browser back to once someone allows an agent
// (routes/agents.consent.tsx). Any client can register itself with any name, so the consent page
// shows this instead of trusting the name: a code sent to a website goes to whoever runs that
// site, so a site we don't know gets a warning. A loopback address or an app's own URL scheme
// (cursor://, vscode://) hands the code to a program on this computer, which is how desktop and
// command-line agents sign in.

// Websites of agents people connect from the browser. A host matches itself and its subdomains.
const KNOWN_AGENT_HOSTS = ["claude.ai", "claude.com", "chatgpt.com", "cursor.com"];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type AgentRedirect =
  // A website: `known` is false for a host outside KNOWN_AGENT_HOSTS.
  | { kind: "web"; host: string; known: boolean }
  // An address on this computer, such as localhost:3334.
  | { kind: "local"; host: string }
  // An app's own scheme, such as cursor.
  | { kind: "app"; scheme: string };

/** What a redirect_uri points at, or null when it isn't a URL. */
export function agentRedirect(redirectUri: string | null | undefined): AgentRedirect | null {
  if (!redirectUri) return null;
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme !== "http" && scheme !== "https") return { kind: "app", scheme };
  const hostname = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost")) {
    return { kind: "local", host: url.host };
  }
  const known = KNOWN_AGENT_HOSTS.some(
    (agentHost) => hostname === agentHost || hostname.endsWith(`.${agentHost}`),
  );
  return { kind: "web", host: url.host, known };
}
