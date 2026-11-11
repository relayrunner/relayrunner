import { describe, expect, test } from "vitest";
import { cleanText, redactSecrets, sanitizeFeedback } from "./feedback.ts";

describe("redactSecrets", () => {
  test.each([
    ["ghp_" + "a".repeat(36)],
    ["github_pat_" + "A1".repeat(20)],
    ["rrm_" + "x".repeat(32)],
    ["eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl"],
    ["AKIAABCDEFGHIJKLMNOP"],
    ["sk-ant-api03-" + "z".repeat(40)],
    ["xoxb-1234567890-abcdefghij"],
    ["-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----"],
  ])("redacts %s", (secret) => {
    const { text, count } = redactSecrets(`before ${secret} after`);
    expect(text).toBe("before [redacted] after");
    expect(count).toBe(1);
  });

  test("keeps the key, header scheme and URL user while redacting the value", () => {
    expect(redactSecrets("API_KEY=abcd1234 password: 'hunter22'").text).toBe(
      "API_KEY=[redacted] password: '[redacted]'",
    );
    expect(redactSecrets("Authorization: Bearer abc.def-123456").text).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redactSecrets("https://bob:pa55@example.com/x").text).toBe(
      "https://[redacted]example.com/x",
    );
  });

  test("leaves ordinary text alone", () => {
    const text = "list_runs returned 3 runs for owner/repo on ubuntu-latest in 42s";
    expect(redactSecrets(text)).toEqual({ text, count: 0 });
  });
});

describe("cleanText", () => {
  test("drops control, zero-width and bidi characters and folds blank lines", () => {
    expect(cleanText("a\u0007b​c‮d\r\n\n\n\ne  ", 100)).toBe("abcd\n\ne");
  });

  test("folds to one line and trims to the limit", () => {
    expect(cleanText(" one\n two\tthree ", 100, true)).toBe("one two three");
    expect(cleanText("abcdefghij", 5)).toBe("abcd…");
  });
});

test("sanitizeFeedback cleans every field and counts redactions", () => {
  expect(
    sanitizeFeedback({
      category: "bug",
      summary: "token ghp_" + "b".repeat(36),
      details: "   ",
      tool: "get_usage; rm -rf",
    }),
  ).toEqual({
    category: "bug",
    summary: "token [redacted]",
    details: null,
    tool: "get_usagerm-rf",
    redacted: 1,
  });
});
