//! Downloads GitHub's actions/runner once per version and checks its SHA-256 before unpacking.
//! A port of apps/cli/install.ts and slots.ts.

use crate::error::Error;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const LATEST_RELEASE: &str = "https://api.github.com/repos/actions/runner/releases/latest";
const ARCHIVE_PREFIX: &str = "https://github.com/actions/runner/releases/download/v";

#[derive(Debug, Clone, PartialEq)]
pub struct Installed {
    pub version: String,
    pub dir: PathBuf,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Download {
    pub version: String,
    pub url: String,
    pub sha256: String,
}

/// The runner's own names for this platform: ("osx" | "linux", "x64" | "arm64").
pub fn platform() -> Result<(&'static str, &'static str), Error> {
    let os = match std::env::consts::OS {
        "macos" => Some("osx"),
        "linux" => Some("linux"),
        _ => None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    };
    // SAFETY: getuid has no preconditions.
    let root = unsafe { libc::getuid() } == 0;
    match (os, arch) {
        (Some(os), Some(arch)) if !root => Ok((os, arch)),
        _ => Err(Error::new(
            "UNSUPPORTED_MACHINE",
            "Run as a regular user on macOS or Linux (x64 or arm64).",
        )),
    }
}

fn is_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

fn version_key(text: &str) -> Vec<u64> {
    text.split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn is_newer(a: &str, b: &str) -> bool {
    version_key(a) > version_key(b)
}

fn is_sha256(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// This platform's archive and checksum out of a release. The checksum comes from the asset's
/// digest or the `<!-- BEGIN SHA osx-arm64 -->` markers in the notes; when both are there they
/// must agree.
pub fn pick_download(release: &Value, (os, arch): (&str, &str)) -> Result<Download, Error> {
    let unexpected = || {
        Error::new(
            "RUNNER_DOWNLOAD",
            "GitHub returned an unexpected runner release.",
        )
    };
    let tag = release["tag_name"].as_str().ok_or_else(unexpected)?;
    let version = tag
        .strip_prefix('v')
        .filter(|v| is_version(v))
        .ok_or_else(unexpected)?;
    let assets = release["assets"].as_array().ok_or_else(unexpected)?;
    let name = format!("actions-runner-{os}-{arch}-{version}.tar.gz");
    let asset = assets.iter().find(|a| a["name"].as_str() == Some(&name));

    let key = format!("{os}-{arch}");
    let from_notes = release["body"].as_str().and_then(|body| {
        let start = format!("<!-- BEGIN SHA {key} -->");
        let end = format!("<!-- END SHA {key} -->");
        let after = &body[body.find(&start)? + start.len()..];
        Some(after[..after.find(&end)?].trim().to_lowercase()).filter(|s| is_sha256(s))
    });
    let from_digest = asset
        .and_then(|a| {
            a["digest"]
                .as_str()?
                .strip_prefix("sha256:")
                .map(str::to_lowercase)
        })
        .filter(|s| is_sha256(s));
    let url = asset
        .and_then(|a| a["browser_download_url"].as_str())
        .filter(|url| {
            url.strip_prefix(ARCHIVE_PREFIX)
                .is_some_and(|rest| rest.ends_with(".tar.gz") && !rest.contains(['?', '#', '\\']))
        });
    let agree = match (&from_digest, &from_notes) {
        (Some(a), Some(b)) => a == b,
        _ => true,
    };
    match (url, from_digest.or(from_notes)) {
        (Some(url), Some(sha256)) if agree => Ok(Download {
            version: version.to_owned(),
            url: url.to_owned(),
            sha256,
        }),
        _ => Err(Error::new(
            "RUNNER_DOWNLOAD",
            format!("GitHub did not provide a {name} archive with a SHA-256 checksum."),
        )),
    }
}

fn agent() -> ureq::Agent {
    crate::api::agent_with(Duration::from_secs(600), true)
}

fn latest_release() -> Result<Value, Error> {
    let fail = |detail: String| {
        Error::new(
            "RUNNER_DOWNLOAD",
            format!("Could not look up the latest actions/runner release ({detail})."),
        )
    };
    // Tests point this at a stand-in. The archive still has to come from GitHub.
    let url =
        std::env::var("RELAYRUNNER_RUNNER_RELEASE_URL").unwrap_or_else(|_| LATEST_RELEASE.into());
    let mut response = agent()
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .call()
        .map_err(|e| fail(e.to_string()))?;
    response
        .body_mut()
        .read_json()
        .map_err(|e| fail(e.to_string()))
}

/// Installed versions, newest first.
pub fn installed(root: &Path) -> Vec<Installed> {
    let mut found: Vec<Installed> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let version = e.file_name().into_string().ok()?;
            (is_version(&version) && e.path().join("run.sh").exists()).then(|| Installed {
                version,
                dir: e.path(),
            })
        })
        .collect();
    found.sort_by_key(|r| std::cmp::Reverse(version_key(&r.version)));
    found
}

/// The latest actions/runner version, or the newest installed one when GitHub can't be reached.
pub fn latest_version(root: &Path, log: &dyn Fn(&str)) -> Result<String, Error> {
    match latest_download() {
        Ok(download) => Ok(download.version),
        Err(e) => newest_installed(root, e, log).map(|newest| newest.version),
    }
}

fn latest_download() -> Result<Download, Error> {
    pick_download(&latest_release()?, platform()?)
}

/// The newest installed runner, for when the latest release couldn't be looked up.
fn newest_installed(root: &Path, e: Error, log: &dyn Fn(&str)) -> Result<Installed, Error> {
    let Some(newest) = installed(root).into_iter().next() else {
        return Err(e);
    };
    log(&format!(
        "Couldn't check for a newer runner ({e}). Using {}.",
        newest.version
    ));
    Ok(newest)
}

/// The latest runner, downloading it if it isn't installed. Falls back to the newest installed
/// one when GitHub can't be reached, so a machine keeps working without GitHub's API.
pub fn ensure(root: &Path, log: &dyn Fn(&str)) -> Result<Installed, Error> {
    // A platform that can't run the runner fails here, never falling back.
    platform()?;
    let download = match latest_download() {
        Ok(download) => download,
        Err(e) => return newest_installed(root, e, log),
    };
    let dir = root.join(&download.version);
    if !dir.join("run.sh").exists() {
        log(&format!(
            "Downloading GitHub's official runner (actions/runner {})…",
            download.version
        ));
        install(root, &download)?;
        log(&format!(
            "Installed actions/runner {} in {}",
            download.version,
            dir.display()
        ));
    }
    Ok(Installed {
        version: download.version,
        dir,
    })
}

/// Downloads, checks and unpacks one runner version into <root>/<version>.
pub fn install(root: &Path, download: &Download) -> Result<(), Error> {
    let io = |e: std::io::Error| Error::new("RUNNER_DOWNLOAD", e.to_string());
    create_private_dir(root).map_err(io)?;
    let temp = root.join(format!(
        ".install-{}-{}",
        std::process::id(),
        fastrand::u32(..)
    ));
    std::fs::create_dir(&temp).map_err(io)?;
    let result = (|| {
        let archive = temp.join("runner.tar.gz");
        let response = agent().get(&download.url).call().map_err(|e| {
            Error::new(
                "RUNNER_DOWNLOAD",
                format!("Runner download failed ({e}). Check network access."),
            )
        })?;
        let mut reader = response.into_body().into_reader();
        let mut file = std::fs::File::create(&archive).map_err(io)?;
        let mut hash = Sha256::new();
        let mut buffer = vec![0; 64 * 1024];
        loop {
            let n = reader.read(&mut buffer).map_err(io)?;
            if n == 0 {
                break;
            }
            hash.update(&buffer[..n]);
            file.write_all(&buffer[..n]).map_err(io)?;
        }
        let digest = format!("{:x}", hash.finalize());
        if digest != download.sha256 {
            return Err(Error::new(
                "RUNNER_CHECKSUM",
                "The runner archive failed SHA-256 verification.",
            ));
        }
        let unpacked = temp.join("runner");
        create_private_dir(&unpacked).map_err(io)?;
        let status = std::process::Command::new("tar")
            .arg("-xzf")
            .arg(&archive)
            .arg("-C")
            .arg(&unpacked)
            .status();
        if !status.is_ok_and(|s| s.success()) {
            return Err(Error::new(
                "RUNNER_EXTRACT",
                "Could not unpack the runner archive. Check tar and available disk space.",
            ));
        }
        match std::fs::rename(&unpacked, root.join(&download.version)) {
            // Another relayrunner installed the same version first. Theirs is just as good.
            Err(e) if root.join(&download.version).join("run.sh").exists() => drop(e),
            other => other.map_err(io)?,
        }
        Ok(())
    })();
    let _ = std::fs::remove_dir_all(&temp);
    result
}

/// Installs a given version from the latest release. For updates while connected.
pub fn install_version(root: &Path, version: &str) -> Result<Installed, Error> {
    let download = latest_download()?;
    if download.version != version {
        return Err(Error::new(
            "RUNNER_DOWNLOAD",
            format!("actions/runner {version} is no longer the latest release."),
        ));
    }
    let dir = root.join(version);
    if !dir.join("run.sh").exists() {
        install(root, &download)?;
    }
    Ok(Installed {
        version: version.to_owned(),
        dir,
    })
}

fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
}

/// <runner>/slot-<n> for slots 1..=count, copying the runner into any that's missing. The copy
/// goes to a temporary directory and is renamed into place, so a slot that's there is complete;
/// on APFS it's a copy-on-write clone.
pub fn ensure_slots(
    runner: &Installed,
    count: u32,
    log: &dyn Fn(&str),
) -> Result<Vec<PathBuf>, Error> {
    let dirs: Vec<PathBuf> = (1..=count)
        .map(|slot| runner.dir.join(format!("slot-{slot}")))
        .collect();
    let missing: Vec<&PathBuf> = dirs.iter().filter(|d| !d.join("run.sh").exists()).collect();
    if !missing.is_empty() {
        log(&if missing.len() == 1 {
            "Setting up a runner copy for one job slot…".to_string()
        } else {
            format!("Setting up runner copies for {} job slots…", missing.len())
        });
    }
    for dir in missing {
        copy_runner(&runner.dir, dir).map_err(|e| {
            Error::new(
                "SLOT_COPY_FAILED",
                format!("Couldn't copy the runner into {}: {e}", dir.display()),
            )
        })?;
    }
    Ok(dirs)
}

fn copy_runner(from: &Path, to: &Path) -> std::io::Result<()> {
    let temp = from.join(format!(
        ".slot-{}-{}",
        std::process::id(),
        fastrand::u32(..)
    ));
    std::fs::create_dir(&temp)?;
    let entries: Vec<PathBuf> = std::fs::read_dir(from)?
        .filter_map(|e| e.ok())
        .filter(|e| {
            let name = e.file_name();
            let name = name.to_string_lossy();
            !name.starts_with("slot-")
                && !name.starts_with('.')
                && name != "_work"
                && name != "job.lock"
        })
        .map(|e| e.path())
        .collect();
    let flags = if cfg!(target_os = "macos") {
        "-cRp"
    } else {
        "-Rp"
    };
    let status = std::process::Command::new("cp")
        .arg(flags)
        .args(&entries)
        .arg(&temp)
        .status()?;
    if !status.success() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(std::io::Error::other("cp failed"));
    }
    std::fs::rename(&temp, to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn release(digest: Option<&str>, notes: Option<&str>) -> Value {
        json!({
            "tag_name": "v2.330.0",
            "body": notes.map(|sha| format!("x\n<!-- BEGIN SHA osx-arm64 -->{sha}<!-- END SHA osx-arm64 -->\n")),
            "assets": [{
                "name": "actions-runner-osx-arm64-2.330.0.tar.gz",
                "browser_download_url": "https://github.com/actions/runner/releases/download/v2.330.0/actions-runner-osx-arm64-2.330.0.tar.gz",
                "digest": digest.map(|d| format!("sha256:{d}")),
            }],
        })
    }

    #[test]
    fn picks_the_archive_and_its_checksum() {
        let picked = pick_download(&release(Some(SHA), None), ("osx", "arm64")).unwrap();
        assert_eq!(picked.version, "2.330.0");
        assert_eq!(picked.sha256, SHA);
        assert_eq!(
            pick_download(&release(None, Some(&SHA.to_uppercase())), ("osx", "arm64"))
                .unwrap()
                .sha256,
            SHA
        );
    }

    #[test]
    fn refuses_missing_or_disagreeing_checksums() {
        let other = "b".repeat(64);
        assert!(pick_download(&release(Some(SHA), Some(&other)), ("osx", "arm64")).is_err());
        assert!(pick_download(&release(None, None), ("osx", "arm64")).is_err());
        assert!(pick_download(&release(Some(SHA), None), ("linux", "x64")).is_err());
        let mut moved = release(Some(SHA), None);
        moved["assets"][0]["browser_download_url"] = "https://evil.example/runner.tar.gz".into();
        assert!(pick_download(&moved, ("osx", "arm64")).is_err());
    }

    #[test]
    fn compares_versions_by_number() {
        assert!(is_newer("2.330.0", "2.329.10"));
        assert!(!is_newer("2.330.0", "2.330.0"));
    }
}
