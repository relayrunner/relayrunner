//! `relayrunner firewall [on|off]`: a firewall on the Mac for isolated jobs. It keeps every job VM
//! off this Mac and the local network, using macOS's own packet filter (pf), from outside the VM
//! where no job can reach it.
//!
//! `on` installs two files with `sudo` and `off` removes them: the rules, and a LaunchDaemon that
//! loads them at startup and again every few minutes, in case something else reloaded pf.

use crate::error::Error;
use crate::isolated::{DAEMON_FILE, RULES_FILE};

// macOS's main ruleset already evaluates every anchor under `com.apple/`.
const ANCHOR: &str = "com.apple/relayrunner";
const LABEL: &str = "app.relayrunner.firewall";
// The network Apple's container tool gives its VMs, and this Mac's address on it.
const VM_NETWORK: &str = "192.168.64.0/24";
const VM_GATEWAY: [u8; 4] = [192, 168, 64, 1];
// Where that network usually lives. It only exists while a VM does.
const DEFAULT_INTERFACE: &str = "bridge100";

/// The interface the VM network is on right now, or the usual one when no VM is running.
fn vm_interface() -> String {
    // SAFETY: getifaddrs hands back a list we only read, then free with freeifaddrs.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return DEFAULT_INTERFACE.into();
        }
        let mut found = None;
        let mut entry = list;
        while !entry.is_null() {
            let addr = (*entry).ifa_addr;
            if !addr.is_null() && i32::from((*addr).sa_family) == libc::AF_INET {
                let ip = (*(addr as *const libc::sockaddr_in)).sin_addr.s_addr;
                if ip.to_ne_bytes() == VM_GATEWAY {
                    found = Some(
                        std::ffi::CStr::from_ptr((*entry).ifa_name)
                            .to_string_lossy()
                            .into_owned(),
                    );
                    break;
                }
            }
            entry = (*entry).ifa_next;
        }
        libc::freeifaddrs(list);
        found.unwrap_or_else(|| DEFAULT_INTERFACE.into())
    }
}

/// A VM may ask for an address (DHCP), look names up (DNS) and reach the internet. Everything else
/// to a private address is dropped, as is anything claiming an address from outside the VM
/// network, and all IPv6 apart from the neighbour discovery the interface needs.
pub fn rules(iface: &str) -> String {
    let gateway = VM_GATEWAY.map(|b| b.to_string()).join(".");
    format!(
        "pass in quick on {iface} proto udp from any port 68 to any port 67
block drop in quick on {iface} inet from ! {VM_NETWORK} to any
pass in quick on {iface} proto {{ udp, tcp }} from {VM_NETWORK} to {gateway} port 53
block drop in quick on {iface} inet to {{ 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 }}
pass in quick on {iface} inet6 proto icmp6 icmp6-type {{ neighbrsol, neighbradv, routersol }}
block drop in quick on {iface} inet6 all
"
    )
}

// Loads the rules and turns pf on if it's off. `pfctl -E` keeps a count of who asked, so it only
// runs when pf is off.
fn load() -> String {
    format!(
        "/sbin/pfctl -q -a {ANCHOR} -f {RULES_FILE}; /sbin/pfctl -s info 2>/dev/null | /usr/bin/grep -q \"Status: Enabled\" || /sbin/pfctl -q -E"
    )
}

pub fn daemon_plist() -> String {
    let load = load()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>{load}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>300</integer>
</dict>
</plist>
"#
    )
}

fn on_script(rules: &str, plist: &str) -> String {
    [
        "set -e".to_string(),
        format!("install -m 644 -o root -g wheel \"{rules}\" {RULES_FILE}"),
        format!("install -m 644 -o root -g wheel \"{plist}\" {DAEMON_FILE}"),
        format!("launchctl bootout system/{LABEL} 2>/dev/null || true"),
        format!("launchctl bootstrap system {DAEMON_FILE}"),
        load(),
    ]
    .join("\n")
}

// pf itself stays as it was: other things on the Mac use it.
fn off_script() -> String {
    [
        format!("launchctl bootout system/{LABEL} 2>/dev/null || true"),
        format!("rm -f {DAEMON_FILE} {RULES_FILE}"),
        format!("/sbin/pfctl -q -a {ANCHOR} -F all 2>/dev/null || true"),
    ]
    .join("\n")
}

fn sudo(script: &str) -> bool {
    println!("This needs your password, to change the Mac's firewall.");
    std::process::Command::new("sudo")
        .args(["/bin/sh", "-c", script])
        .status()
        .is_ok_and(|s| s.success())
}

pub async fn command(state: Option<&str>) -> Result<(), Error> {
    if let Some(reason) = crate::isolated::unsupported_reason().await {
        return Err(Error::new(
            "ISOLATED_UNSUPPORTED",
            reason.replace("Running jobs in VMs needs", "The firewall needs"),
        ));
    }
    let failed = |message: &str| Err(Error::new("FIREWALL_FAILED", message));
    match state {
        None if crate::isolated::firewall_installed() => println!(
            "The firewall on this Mac is on. Isolated jobs can reach the internet, not this Mac or your local network.\nTurn it off with `relayrunner firewall off`."
        ),
        None => println!(
            "The firewall on this Mac is off. Isolated jobs rely on the firewall inside each VM, which a job using Docker can remove.\nTurn it on with `relayrunner firewall on`."
        ),
        Some("off") => {
            if !sudo(&off_script()) {
                return failed("Couldn't turn the firewall off.");
            }
            println!("The firewall on this Mac is off.");
        }
        Some("on") => {
            let dir = std::env::temp_dir().join(format!(
                "relayrunner-firewall-{}-{}",
                std::process::id(),
                fastrand::u32(..)
            ));
            let io = |e: std::io::Error| Error::new("FIREWALL_FAILED", e.to_string());
            std::fs::create_dir(&dir).map_err(io)?;
            let (rules_path, plist_path) = (dir.join("rules"), dir.join("daemon.plist"));
            let ok = std::fs::write(&rules_path, rules(&vm_interface()))
                .and_then(|()| std::fs::write(&plist_path, daemon_plist()))
                .map_err(io)
                .map(|()| {
                    sudo(&on_script(
                        &rules_path.display().to_string(),
                        &plist_path.display().to_string(),
                    ))
                });
            let _ = std::fs::remove_dir_all(&dir);
            if !ok? {
                return failed("Couldn't turn the firewall on.");
            }
            println!(
                "The firewall on this Mac is on. Isolated jobs can reach the internet, not this Mac or your local network.\nIt also applies to other VMs that use Apple's shared VM network. Turn it off with `relayrunner firewall off`."
            );
        }
        Some(_) => {
            return Err(Error::new(
                "USAGE",
                "Use `relayrunner firewall on` or `relayrunner firewall off`.",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_rules() {
        assert_eq!(
            rules("bridge100").lines().nth(2),
            Some(
                "pass in quick on bridge100 proto { udp, tcp } from 192.168.64.0/24 to 192.168.64.1 port 53"
            )
        );
        assert!(daemon_plist().contains("grep -q \"Status: Enabled\" || /sbin/pfctl -q -E"));
    }
}
