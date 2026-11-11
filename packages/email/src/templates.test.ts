import { describe, expect, it } from "vitest";
import {
  renderAgentFeedbackEmail,
  renderDeadLetterAlertEmail,
  renderPriceCheckEmail,
  renderInviteEmail,
  renderMachineConnectedEmail,
  renderMachineTakenOverEmail,
  renderWelcomeEmail,
} from "./index.ts";

describe("templates", () => {
  it("agent-feedback names who sent it and escapes every agent-written field", () => {
    const email = renderAgentFeedbackEmail({
      id: "f1",
      category: "bug",
      summary: "<img src=x onerror=alert(1)>",
      details: "line one\n<script>bad()</script>",
      tool: "list_runs",
      redacted: 2,
      user: { name: "Ada", email: "ada@example.com" },
      workspaceName: "Acme & Co",
      clientName: "Claude",
      sentAt: new Date("2026-11-11T00:00:00Z"),
    });
    expect(email.subject).toBe("[feedback] bug: <img src=x onerror=alert(1)>");
    expect(email.html).not.toContain("<img");
    expect(email.html).not.toContain("<script>");
    expect(email.text).toContain("From: Ada <ada@example.com>");
    expect(email.text).toContain("Redacted: 2 secret-like value(s)");
    expect(email.text).toContain("line one\n<script>bad()</script>");
  });

  it("welcome links the dashboard in both bodies", () => {
    const email = renderWelcomeEmail({ name: "Ada", dashboardUrl: "https://app.example/" });
    expect(email.subject).toBe("Welcome to RelayRunner");
    expect(email.text).toContain("Hi Ada,");
    expect(email.text).toContain("Dashboard: https://app.example");
    expect(email.html).toContain('href="https://app.example"');
  });

  it("machine-taken-over names both places and escapes the machine name", () => {
    const email = renderMachineTakenOverEmail({
      machineName: "<b>mbp</b>",
      was: { ip: "198.51.100.1", country: "US", city: "Boston" },
      now: { ip: "203.0.113.9", country: "PT", city: null },
      at: new Date("2026-11-10T00:00:00Z"),
      machinesUrl: "https://app.example/runners",
    });
    expect(email.subject).toBe("<b>mbp</b> connected from another address");
    expect(email.html).not.toContain("<b>mbp</b>");
    expect(email.text).toContain("online from Boston, US when a new connection from PT took over");
    expect(email.text).toContain("(198.51.100.1 → 203.0.113.9)");
    expect(email.text).toContain("https://app.example/runners");
  });

  it("machine-connected lists every workspace and escapes user-chosen names in HTML", () => {
    const email = renderMachineConnectedEmail({
      machineName: "<script>alert(1)</script>",
      os: "macos",
      arch: "arm64",
      workspaceNames: ["Acme & Co", "atticoos"],
      connectedAt: new Date("2026-11-05T00:00:00Z"),
      machinesUrl: "https://app.example/runners",
    });
    expect(email.subject).toBe("New machine connected to Acme & Co and atticoos");
    expect(email.html).not.toContain("<script>alert(1)</script>");
    expect(email.html).toContain("&lt;script&gt;");
    expect(email.html).toContain("Acme &amp; Co</strong> and <strong");
    expect(email.text).toContain("(macos arm64)");
    expect(email.text).toContain("It can now run CI jobs in Acme & Co and atticoos");
    expect(email.text).toContain("Not you? Revoke it: https://app.example/runners");
  });

  it("machine-connected still reads right with no workspace yet", () => {
    const email = renderMachineConnectedEmail({
      machineName: "mbp",
      workspaceNames: [],
      connectedAt: new Date("2026-11-05T00:00:00Z"),
      machinesUrl: "https://app.example/runners",
    });
    expect(email.subject).toBe("New machine connected to RelayRunner");
    expect(email.text).toContain("once you install RelayRunner on a GitHub account");
  });

  it("dead-letter alert counts deliveries", () => {
    const email = renderDeadLetterAlertEmail({
      count: 12,
      threshold: 10,
      inspectorUrl: "https://app.example/admin/webhooks",
    });
    expect(email.subject).toBe("[webhooks] 12 deliveries dead-lettered in the past hour");
    expect(email.text).toContain("https://app.example/admin/webhooks");
  });

  it("price check lists changes and unreadable pages", () => {
    const email = renderPriceCheckEmail({
      changes: [{ name: "Depot linux", price: "$0.0035/min", from: "2026-11-20" }],
      failures: [{ name: "Blacksmith", error: "answered 404" }],
      pricesUrl: "https://app.example/admin/prices",
    });
    expect(email.subject).toBe("[prices] 1 price changed");
    expect(email.text).toContain("Depot linux: $0.0035/min from 2026-11-20");
    expect(email.text).toContain("Blacksmith: couldn't read the price page (answered 404)");
    expect(email.text).toContain("https://app.example/admin/prices");
  });

  it("invite links the accept page and escapes names", () => {
    const email = renderInviteEmail({
      inviterName: "Ada <ada>",
      workspaceName: "Acme & Co",
      role: "admin",
      acceptUrl: "https://app.example/invite/inv_1",
      expiresAt: new Date("2026-11-07T00:00:00Z"),
    });
    expect(email.subject).toBe("Ada <ada> invited you to Acme & Co on RelayRunner");
    expect(email.html).toContain("Ada &lt;ada&gt;");
    expect(email.html).toContain('href="https://app.example/invite/inv_1"');
    expect(email.text).toContain("as an admin");
    expect(email.text).toContain("Accept: https://app.example/invite/inv_1");
  });
});
