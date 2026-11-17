//! The checkout `relayrunner init` runs in: its root, its workflow files, and which GitHub repo
//! `origin` points at and whether that repo is public. Nothing here needs a GitHub sign-in.

use super::workflows::WorkflowFile;
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const WORKFLOWS_DIR: &str = ".github/workflows";

/// The nearest directory at or above `from` that holds a `.git`, or None outside a checkout.
pub fn find_root(from: &Path) -> Option<PathBuf> {
    from.ancestors()
        .find(|dir| dir.join(".git").exists())
        .map(Path::to_path_buf)
}

pub fn read_workflow_files(root: &Path) -> Vec<WorkflowFile> {
    let Ok(entries) = std::fs::read_dir(root.join(WORKFLOWS_DIR)) else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|name| name.ends_with(".yml") || name.ends_with(".yaml"))
        .collect();
    names.sort();
    names
        .into_iter()
        .filter_map(|name| {
            let source = std::fs::read_to_string(root.join(WORKFLOWS_DIR).join(&name)).ok()?;
            Some(WorkflowFile {
                file: format!("{WORKFLOWS_DIR}/{name}"),
                source,
            })
        })
        .collect()
}

/// `owner/name` from a GitHub remote URL (https or ssh), or None for anything else.
pub fn parse_github_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let path = if let Some(rest) = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        // An optional user (or token) before the host.
        let rest = match rest.split_once('@') {
            Some((user, host)) if !user.is_empty() && !user.contains('/') => host,
            _ => rest,
        };
        rest.strip_prefix("github.com/")?
    } else {
        url.strip_prefix("git@github.com:")
            .or_else(|| url.strip_prefix("ssh://git@github.com/"))?
    };
    let path = path.strip_suffix('/').unwrap_or(path);
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
    };
    (valid(owner) && valid(name)).then(|| format!("{owner}/{name}"))
}

pub fn origin_repo(root: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_github_remote(&String::from_utf8_lossy(&output.stdout))
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Visibility {
    Public,
    Private,
    Unknown,
}

impl Visibility {
    pub fn as_str(self) -> &'static str {
        match self {
            Visibility::Public => "public",
            Visibility::Private => "private",
            Visibility::Unknown => "unknown",
        }
    }
}

/// Asks GitHub without signing in. A public repo answers; a private one (or one that doesn't
/// exist) is a 404 to an anonymous caller. Anything else, such as no network or a rate limit, is
/// unknown.
pub fn visibility(repo: &str) -> Visibility {
    let reply = crate::api::agent_with(Duration::from_secs(5), false)
        .get(&format!("https://api.github.com/repos/{repo}"))
        .header("accept", "application/vnd.github+json")
        .call();
    let Ok(mut response) = reply else {
        return Visibility::Unknown;
    };
    match response.status().as_u16() {
        404 => Visibility::Private,
        200..=299 => match response.body_mut().read_json::<serde_json::Value>() {
            Ok(body) if body["private"] == false => Visibility::Public,
            Ok(_) => Visibility::Private,
            Err(_) => Visibility::Unknown,
        },
        _ => Visibility::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_remotes() {
        for (url, repo) in [
            ("https://github.com/acme/web.git", Some("acme/web")),
            ("https://github.com/acme/web", Some("acme/web")),
            ("https://token@github.com/acme/web.git", Some("acme/web")),
            ("git@github.com:acme/my.repo.git", Some("acme/my.repo")),
            ("ssh://git@github.com/acme/web.git", Some("acme/web")),
            ("https://github.com/acme/web/\n", Some("acme/web")),
            ("https://gitlab.com/acme/web.git", None),
            ("https://github.com/acme/web/tree", None),
        ] {
            assert_eq!(parse_github_remote(url).as_deref(), repo, "{url}");
        }
    }

    #[test]
    fn finds_the_root_from_a_subdirectory() {
        let root = std::env::temp_dir().join(format!("rr-root-{}", fastrand::u32(..)));
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(root.join("src/deep")).unwrap();
        assert_eq!(find_root(&root.join("src/deep")), Some(root.clone()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
