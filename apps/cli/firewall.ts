// `relayrunner firewall [on|off]`: a firewall on the Mac for `connect --isolated`. It keeps every
// job VM off this Mac and the local network, using macOS's own packet filter (pf). The firewall
// inside the VM does the same, but Docker runs as root there, so a job that sets out to remove
// that one can. This one sits outside the VM, where no job can reach it.
//
// `on` installs two files with `sudo` and `off` removes them: the rules, and a LaunchDaemon that
// loads them at startup and again every few minutes, in case something else reloaded pf.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { unsupportedReason } from "./isolated.ts";

// macOS's main ruleset already evaluates every anchor under `com.apple/`, so rules loaded here
// take effect without touching /etc/pf.conf.
const ANCHOR = "com.apple/relayrunner";
const LABEL = "app.relayrunner.firewall";
export const RULES_FILE = "/etc/pf.anchors/app.relayrunner";
export const DAEMON_FILE = `/Library/LaunchDaemons/${LABEL}.plist`;

// The network Apple's container tool gives its VMs, and this Mac's address on it.
const VM_NETWORK = "192.168.64.0/24";
const VM_GATEWAY = "192.168.64.1";
// Where that network usually lives. It only exists while a VM does.
const DEFAULT_INTERFACE = "bridge100";

// The interface the VM network is on right now, or the usual one when no VM is running.
export function vmInterface(interfaces = networkInterfaces()) {
  for (const [name, addresses] of Object.entries(interfaces))
    if (addresses?.some((address) => address.address === VM_GATEWAY)) return name;
  return DEFAULT_INTERFACE;
}

// pf sees a VM's traffic as arriving on the VM network's interface. A VM may ask for an address
// (DHCP) and look names up (DNS), and reach the internet. Everything else to a private address is
// dropped: this Mac, the local network, link-local. So is anything that claims an address from
// outside the VM network, which would otherwise get past the rule below it, and all IPv6 apart
// from the neighbour discovery the interface needs.
export function firewallRules(iface: string) {
  return `pass in quick on ${iface} proto udp from any port 68 to any port 67
block drop in quick on ${iface} inet from ! ${VM_NETWORK} to any
pass in quick on ${iface} proto { udp, tcp } from ${VM_NETWORK} to ${VM_GATEWAY} port 53
block drop in quick on ${iface} inet to { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }
pass in quick on ${iface} inet6 proto icmp6 icmp6-type { neighbrsol, neighbradv, routersol }
block drop in quick on ${iface} inet6 all
`;
}

// Loads the rules and turns pf on if it's off. `pfctl -E` keeps a count of who asked, so it only
// runs when pf is off.
const LOAD = `/sbin/pfctl -q -a ${ANCHOR} -f ${RULES_FILE}; /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q "Status: Enabled" || /sbin/pfctl -q -E`;

export function daemonPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${LOAD.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
</dict>
</plist>
`;
}

// What `sudo` runs to turn the firewall on, given the two files written somewhere temporary.
export function onScript(rules: string, plist: string) {
  return [
    "set -e",
    `install -m 644 -o root -g wheel "${rules}" ${RULES_FILE}`,
    `install -m 644 -o root -g wheel "${plist}" ${DAEMON_FILE}`,
    `launchctl bootout system/${LABEL} 2>/dev/null || true`,
    `launchctl bootstrap system ${DAEMON_FILE}`,
    LOAD,
  ].join("\n");
}

// What `sudo` runs to turn it off. pf itself stays as it was: other things on the Mac use it.
export function offScript() {
  return [
    `launchctl bootout system/${LABEL} 2>/dev/null || true`,
    `rm -f ${DAEMON_FILE} ${RULES_FILE}`,
    `/sbin/pfctl -q -a ${ANCHOR} -F all 2>/dev/null || true`,
  ].join("\n");
}

// Whether `firewall on` has been run on this Mac. Reading pf itself needs root, so this goes by
// the files it installed.
export function firewallInstalled(exists: (path: string) => boolean = existsSync) {
  return exists(RULES_FILE) && exists(DAEMON_FILE);
}

function sudo(script: string) {
  console.log("This needs your password, to change the Mac's firewall.");
  const result = spawnSync("sudo", ["/bin/sh", "-c", script], { stdio: "inherit" });
  return result.status === 0;
}

function status() {
  if (!firewallInstalled()) {
    console.log(
      "The firewall on this Mac is off. Isolated jobs rely on the firewall inside each VM, which a job using Docker can remove.\nTurn it on with `relayrunner firewall on`.",
    );
    return;
  }
  console.log(
    "The firewall on this Mac is on. Isolated jobs can reach the internet, not this Mac or your local network.\nTurn it off with `relayrunner firewall off`.",
  );
}

export const firewallCommand = defineCommand({
  meta: {
    name: "firewall",
    description:
      "Show or change the firewall on this Mac that keeps isolated jobs off the Mac and your local network.",
  },
  args: {
    state: {
      type: "positional",
      required: false,
      description: "on or off; leave out to show the current setting",
    },
  },
  run({ args }) {
    const fail = (message: string) => {
      console.error(message);
      process.exitCode = 1;
    };
    const unsupported = unsupportedReason();
    if (unsupported) return fail(unsupported.replace("--isolated needs", "The firewall needs"));
    if (!args.state) return status();
    if (args.state === "off") {
      if (!sudo(offScript())) return fail("Couldn't turn the firewall off.");
      console.log("The firewall on this Mac is off.");
      return;
    }
    if (args.state !== "on")
      return fail("Use `relayrunner firewall on` or `relayrunner firewall off`.");

    const dir = mkdtempSync(join(tmpdir(), "relayrunner-firewall-"));
    try {
      const rules = join(dir, "rules");
      const plist = join(dir, "daemon.plist");
      writeFileSync(rules, firewallRules(vmInterface()));
      writeFileSync(plist, daemonPlist());
      if (!sudo(onScript(rules, plist))) return fail("Couldn't turn the firewall on.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    console.log(
      "The firewall on this Mac is on. Isolated jobs can reach the internet, not this Mac or your local network.\nIt also applies to other VMs that use Apple's shared VM network. Turn it off with `relayrunner firewall off`.",
    );
  },
});
