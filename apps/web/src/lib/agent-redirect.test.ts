import { describe, expect, test } from "vitest";
import { agentRedirect } from "./agent-redirect";

describe("agentRedirect", () => {
  test("marks a known agent website and its subdomains as known", () => {
    expect(agentRedirect("https://claude.ai/api/mcp/auth_callback")).toEqual({
      kind: "web",
      host: "claude.ai",
      known: true,
    });
    expect(agentRedirect("https://app.cursor.com/cb")).toEqual({
      kind: "web",
      host: "app.cursor.com",
      known: true,
    });
  });

  test("flags any other website", () => {
    expect(agentRedirect("https://example.com/cb")).toEqual({
      kind: "web",
      host: "example.com",
      known: false,
    });
    // A look-alike that only ends with a known name is not that site.
    expect(agentRedirect("https://evilclaude.ai/cb")).toMatchObject({ known: false });
    expect(agentRedirect("https://claude.ai.example.com/cb")).toMatchObject({ known: false });
  });

  test("treats loopback addresses as this computer", () => {
    expect(agentRedirect("http://localhost:3334/callback")).toEqual({
      kind: "local",
      host: "localhost:3334",
    });
    expect(agentRedirect("http://127.0.0.1:8080/cb")).toEqual({
      kind: "local",
      host: "127.0.0.1:8080",
    });
    expect(agentRedirect("http://[::1]:9000/cb")).toEqual({ kind: "local", host: "[::1]:9000" });
  });

  test("treats a custom scheme as an app on this computer", () => {
    expect(agentRedirect("cursor://anysphere.cursor-mcp/oauth/callback")).toEqual({
      kind: "app",
      scheme: "cursor",
    });
  });

  test("returns null without a usable URL", () => {
    expect(agentRedirect(null)).toBeNull();
    expect(agentRedirect("")).toBeNull();
    expect(agentRedirect("not a url")).toBeNull();
  });
});
