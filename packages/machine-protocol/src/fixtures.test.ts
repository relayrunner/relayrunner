import { describe, expect, it } from "vitest";
import fixtures from "../fixtures.json" with { type: "json" };
import { parseGatewayMessage, parseMachineMessage } from "./messages.ts";

// The Rust client (apps/cli-rs) reads the same file. Parsing must keep every field, since zod drops
// keys it doesn't know and a field one side sends but the other doesn't read would go unnoticed.
describe("shared fixtures", () => {
  it.each(Object.entries(fixtures.machine))("machine %s parses as is", (_, message) => {
    expect(parseMachineMessage(JSON.stringify(message))).toEqual({ ok: true, message });
  });

  it.each(Object.entries(fixtures.gateway))("gateway %s parses as is", (_, message) => {
    expect(parseGatewayMessage(JSON.stringify(message))).toEqual({ ok: true, message });
  });
});
