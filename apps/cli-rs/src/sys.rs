//! Small reads of this machine: a command's output, a file, CPU count and memory.

use std::time::Duration;

/// A command's trimmed stdout, or None when it fails, isn't there, or takes over 3 seconds.
pub async fn run(command: &str, args: &[&str]) -> Option<String> {
    let output = tokio::process::Command::new(command)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = tokio::time::timeout(Duration::from_secs(3), output)
        .await
        .ok()?
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (output.status.success() && !text.is_empty()).then_some(text)
}

/// A file as trimmed text, without the NUL device-tree strings end in.
pub fn read(path: &str) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?.replace('\0', "");
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

pub fn cpu_count() -> u32 {
    std::thread::available_parallelism().map_or(1, |n| n.get() as u32)
}

/// Total memory in bytes.
/// Read once: it doesn't change while `connect` runs.
pub async fn total_memory() -> u64 {
    static TOTAL: tokio::sync::OnceCell<u64> = tokio::sync::OnceCell::const_new();
    *TOTAL
        .get_or_init(|| async {
            if cfg!(target_os = "macos") {
                run("sysctl", &["-n", "hw.memsize"])
                    .await
                    .and_then(|s| s.parse().ok())
                    .unwrap_or(0)
            } else {
                read("/proc/meminfo")
                    .and_then(|text| {
                        let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
                        line.split_whitespace().nth(1)?.parse::<u64>().ok()
                    })
                    .map_or(0, |kb| kb * 1024)
            }
        })
        .await
}

/// Runs blocking work off the async runtime.
pub async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, crate::error::Error> + Send + 'static,
) -> Result<T, crate::error::Error> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| crate::error::Error::new("INTERNAL", e.to_string()))?
}
