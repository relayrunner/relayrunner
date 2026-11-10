import { describe, expect, it } from "vitest";
import { normalizeServer } from "./server.ts";

describe("normalizeServer", () => {
  it("keeps the origin of an https URL", () => {
    expect(normalizeServer("https://app.relayrunner.app/runners?x=1")).toBe(
      "https://app.relayrunner.app",
    );
  });

  it("allows plain http on this computer", () => {
    for (const url of ["http://localhost:8787", "http://127.0.0.1:5173", "http://[::1]:8787"])
      expect(normalizeServer(url)).toBe(url);
  });

  it("refuses plain http anywhere else, since the token goes out on every connect", () => {
    expect(() => normalizeServer("http://relayrunner.example")).toThrow(/isn't https/);
    expect(() => normalizeServer("http://127.0.0.1.evil.example")).toThrow(/isn't https/);
  });

  it("refuses what isn't a web URL", () => {
    expect(() => normalizeServer("ftp://example.com")).toThrow(/Not a valid RelayRunner URL/);
    expect(() => normalizeServer("nope")).toThrow(/Not a valid RelayRunner URL/);
  });
});
