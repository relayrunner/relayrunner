import { describe, expect, it } from "vitest";
import {
  DAEMON_FILE,
  daemonPlist,
  firewallInstalled,
  firewallRules,
  offScript,
  onScript,
  RULES_FILE,
  vmInterface,
} from "./firewall.ts";

describe("vmInterface", () => {
  it("finds the interface that holds the VM network's gateway", () => {
    expect(
      vmInterface({
        en0: [{ address: "192.168.3.242" }],
        bridge101: [{ address: "fe80::1" }, { address: "192.168.64.1" }],
      } as never),
    ).toBe("bridge101");
  });

  it("falls back to the usual interface when no VM is running", () => {
    expect(vmInterface({ en0: [{ address: "192.168.3.242" }] } as never)).toBe("bridge100");
  });
});

describe("firewallRules", () => {
  const rules = firewallRules("bridge100").trimEnd().split("\n");

  it("lets a VM get an address and look names up before anything is blocked", () => {
    expect(rules[0]).toContain("port 68 to any port 67");
    expect(rules.findIndex((rule) => rule.includes("port 53"))).toBeLessThan(
      rules.findIndex((rule) => rule.includes("192.168.0.0/16 }")),
    );
  });

  it("drops addresses from outside the VM network before the rule that lets DNS through", () => {
    expect(rules[1]).toBe("block drop in quick on bridge100 inet from ! 192.168.64.0/24 to any");
  });

  it("blocks private addresses and IPv6, on the VM interface only", () => {
    expect(rules.join("\n")).toContain("10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16");
    expect(rules.at(-1)).toBe("block drop in quick on bridge100 inet6 all");
    for (const rule of rules) expect(rule).toContain(" on bridge100 ");
  });
});

describe("the install", () => {
  it("installs both files as root and loads the rules now and at startup", () => {
    const script = onScript("/tmp/x/rules", "/tmp/x/daemon.plist");
    expect(script).toContain(`"/tmp/x/rules" ${RULES_FILE}`);
    expect(script).toContain(`launchctl bootstrap system ${DAEMON_FILE}`);
    expect(script).toContain(`-a com.apple/relayrunner -f ${RULES_FILE}`);
    expect(daemonPlist()).toContain("<key>RunAtLoad</key>");
    // The command is XML: its `2>` must be escaped.
    expect(daemonPlist()).toContain("2&gt;/dev/null");
  });

  it("removes both files and the rules, and leaves pf itself on", () => {
    const script = offScript();
    expect(script).toContain(`rm -f ${DAEMON_FILE} ${RULES_FILE}`);
    expect(script).toContain("-a com.apple/relayrunner -F all");
    expect(script).not.toContain("pfctl -d");
  });

  it("counts as on only with both files in place", () => {
    expect(firewallInstalled(() => true)).toBe(true);
    expect(firewallInstalled((path) => path === RULES_FILE)).toBe(false);
  });
});
