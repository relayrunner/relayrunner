//! What kind of device this is, for `hello`: best effort, each part
//! from a file or a quick command, and anything unreadable left out.

use crate::protocol::Device;
use crate::sys;

pub async fn detect() -> Device {
    let mut device = if cfg!(target_os = "macos") {
        mac().await
    } else {
        linux().await
    };
    let chip = if cfg!(target_os = "macos") {
        sys::run("sysctl", &["-n", "machdep.cpu.brand_string"]).await
    } else {
        sys::read("/proc/cpuinfo").and_then(|text| {
            text.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split_once(':'))
                .map(|(_, v)| v.trim().to_string())
        })
    };
    device.chip = clean_chip(chip.as_deref());
    device.cpu_cores = Some(sys::cpu_count());
    let memory = sys::total_memory().await;
    device.memory_mb = (memory > 0).then(|| (memory as f64 / 1024.0 / 1024.0).round() as u64);
    for field in [
        &mut device.model,
        &mut device.model_id,
        &mut device.chip,
        &mut device.os_version,
    ] {
        if let Some(text) = field.as_mut() {
            *text = text.chars().take(120).collect();
        }
        if field.as_deref() == Some("") {
            *field = None;
        }
    }
    device
}

async fn mac() -> Device {
    let (model_id, profile, virtual_, version) = tokio::join!(
        sys::run("sysctl", &["-n", "hw.model"]),
        sys::run("system_profiler", &["SPHardwareDataType", "-json"]),
        sys::run("sysctl", &["-n", "kern.hv_vmm_present"]),
        sys::run("sw_vers", &["-productVersion"]),
    );
    // system_profiler's machine_name is Apple's own marketing name.
    let model = profile
        .and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok())
        .and_then(|v| {
            v["SPHardwareDataType"][0]["machine_name"]
                .as_str()
                .map(|s| s.trim().to_string())
        })
        .filter(|s| !s.is_empty())
        .or_else(|| mac_model_from_id(model_id.as_deref()));
    let is_vm = virtual_.as_deref() == Some("1")
        || model_id
            .as_deref()
            .is_some_and(|m| m.starts_with("VirtualMac"));
    Device {
        kind: if is_vm {
            "vm"
        } else {
            mac_kind(model.as_deref())
        },
        model: if is_vm { None } else { model },
        model_id,
        os_version: version.map(|v| format!("macOS {v}")),
        ..Default::default()
    }
}

const MAC_FAMILIES: [(&str, &str); 7] = [
    ("MacBookPro", "MacBook Pro"),
    ("MacBookAir", "MacBook Air"),
    ("MacBook", "MacBook"),
    ("Macmini", "Mac mini"),
    ("MacPro", "Mac Pro"),
    ("iMacPro", "iMac Pro"),
    ("iMac", "iMac"),
];

fn mac_model_from_id(id: Option<&str>) -> Option<String> {
    let id = id?;
    MAC_FAMILIES
        .iter()
        .find(|(prefix, _)| id.starts_with(prefix))
        .map(|(_, name)| name.to_string())
}

fn mac_kind(model: Option<&str>) -> &'static str {
    match model {
        Some(m) if m.starts_with("MacBook") => "laptop",
        Some(m)
            if ["iMac", "Mac mini", "Mac Studio", "Mac Pro"]
                .iter()
                .any(|p| m.starts_with(p)) =>
        {
            "desktop"
        }
        _ => "unknown",
    }
}

async fn linux() -> Device {
    let dmi = |name: &str| sys::read(&format!("/sys/class/dmi/id/{name}"));
    let vendor = dmi("sys_vendor");
    let product = dmi("product_name");
    // Lenovo keeps the name people know in product_version.
    let lenovo = if vendor
        .as_deref()
        .is_some_and(|v| v.eq_ignore_ascii_case("lenovo"))
    {
        dmi("product_version")
    } else {
        None
    };
    let board = sys::read("/proc/device-tree/model");
    let model = real_name(lenovo.as_deref())
        .or_else(|| real_name(product.as_deref()))
        .or_else(|| real_name(board.as_deref()));
    let vm = is_linux_vm(vendor.as_deref(), product.as_deref()).await;
    Device {
        kind: if vm {
            "vm"
        } else {
            chassis_kind(dmi("chassis_type").as_deref())
        },
        model,
        model_id: product.or(board),
        os_version: os_release(sys::read("/etc/os-release").as_deref()),
        ..Default::default()
    }
}

async fn is_linux_vm(vendor: Option<&str>, product: Option<&str>) -> bool {
    if sys::run("systemd-detect-virt", &["--vm"])
        .await
        .is_some_and(|v| v != "none")
    {
        return true;
    }
    let has = |text: Option<&str>, words: &[&str]| {
        text.map(str::to_lowercase)
            .is_some_and(|t| words.iter().any(|w| t.contains(w)))
    };
    has(
        vendor,
        &[
            "qemu",
            "kvm",
            "vmware",
            "virtualbox",
            "innotek",
            "xen",
            "bochs",
            "parallels",
            "amazon ec2",
            "google",
        ],
    ) || has(
        product,
        &["virtual machine", "vmware", "virtualbox", "kvm", "hvm domu"],
    ) || sys::read("/proc/cpuinfo").is_some_and(|t| {
        t.lines()
            .any(|l| l.starts_with("flags") && l.split_whitespace().any(|f| f == "hypervisor"))
    })
}

fn chassis_kind(chassis: Option<&str>) -> &'static str {
    match chassis.and_then(|c| c.parse::<u32>().ok()) {
        Some(3..=7 | 13 | 15 | 16 | 24 | 35 | 36) => "desktop",
        Some(8..=10 | 14 | 31 | 32) => "laptop",
        Some(17 | 23 | 25 | 28 | 29) => "server",
        _ => "unknown",
    }
}

/// A model name worth showing, or None for a placeholder firmware filled in.
fn real_name(name: Option<&str>) -> Option<String> {
    let trimmed = name?.trim();
    let lower = trimmed.to_lowercase();
    let placeholder = trimmed.is_empty()
        || trimmed.bytes().all(|b| b.is_ascii_digit())
        || [
            "to be filled by o.e.m.",
            "to be filled by oem",
            "system product name",
            "system version",
            "default string",
            "not specified",
            "not applicable",
            "o.e.m.",
            "oem",
            "none",
            "unknown",
        ]
        .contains(&lower.as_str())
        || lower.starts_with("standard pc");
    (!placeholder).then(|| trimmed.to_string())
}

/// "Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz" → "Intel Xeon Gold 6338".
fn clean_chip(model: Option<&str>) -> Option<String> {
    let mut text = model?.to_string();
    for mark in ["(R)", "(r)", "(TM)", "(tm)", "(C)", "(c)"] {
        text = text.replace(mark, "");
    }
    if let Some(at) = text.find(" CPU @").or_else(|| text.find(" @ ")) {
        text.truncate(at);
    }
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut words = words;
    if words.len() >= 2
        && words[words.len() - 1] == "Processor"
        && words[words.len() - 2].ends_with("-Core")
    {
        words.truncate(words.len() - 2);
    }
    let cleaned = words.join(" ");
    (!cleaned.is_empty() && !cleaned.eq_ignore_ascii_case("unknown")).then_some(cleaned)
}

/// PRETTY_NAME from /etc/os-release.
fn os_release(text: Option<&str>) -> Option<String> {
    let value = text?
        .lines()
        .find_map(|l| l.strip_prefix("PRETTY_NAME="))?
        .trim();
    let value = value.trim_matches(['"', '\'']);
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_chip_names() {
        assert_eq!(
            clean_chip(Some("Intel(R) Xeon(R) Gold 6338 CPU @ 2.00GHz")).as_deref(),
            Some("Intel Xeon Gold 6338")
        );
        assert_eq!(
            clean_chip(Some("AMD Ryzen 9 5950X 16-Core Processor")).as_deref(),
            Some("AMD Ryzen 9 5950X")
        );
        assert_eq!(
            clean_chip(Some("Apple M3 Pro")).as_deref(),
            Some("Apple M3 Pro")
        );
        assert_eq!(clean_chip(Some("unknown")), None);
    }

    #[test]
    fn reads_models_and_kinds() {
        assert_eq!(real_name(Some("To be filled by O.E.M.")), None);
        assert_eq!(real_name(Some("Standard PC (Q35 + ICH9, 2009)")), None);
        assert_eq!(
            real_name(Some("ThinkPad X1")).as_deref(),
            Some("ThinkPad X1")
        );
        assert_eq!(chassis_kind(Some("10")), "laptop");
        assert_eq!(chassis_kind(Some("23")), "server");
        assert_eq!(mac_kind(Some("Mac Studio")), "desktop");
        assert_eq!(
            mac_model_from_id(Some("MacBookPro18,3")).as_deref(),
            Some("MacBook Pro")
        );
        assert_eq!(
            os_release(Some("NAME=x\nPRETTY_NAME=\"Ubuntu 24.04.1 LTS\"\n")).as_deref(),
            Some("Ubuntu 24.04.1 LTS")
        );
    }
}
