//! Commits and pushes the workflow change `eval` makes, after the person says yes. The commit is
//! made on top of the default branch as `origin` has it, without touching the checkout's branch or
//! index, so it holds this one file's change and nothing else:
//!
//! - On the default branch, with nothing else changed and level with `origin`, it's pushed there
//!   and the checkout moves up to it.
//! - Otherwise, or when the push is refused (a protected branch), it's pushed to a new branch
//!   `relayrunner/route-<workflow>`, with GitHub's link to open a pull request.
//!
//! It never force-pushes.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Where the change went.
#[derive(Debug, PartialEq)]
pub enum Pushed {
    /// Pushed to the default branch.
    Default,
    /// Pushed to a branch of its own, with the link that opens its pull request.
    Branch { branch: String, compare: String },
}

/// The checkout as it was before the edit.
pub struct Before {
    branch: Option<String>,
    /// No tracked file had changes.
    clean: bool,
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    git_with(root, args, None, &[]).map(|out| out.trim().to_string())
}

fn git_with(
    root: &Path,
    args: &[&str],
    input: Option<&str>,
    env: &[(&str, &Path)],
) -> Result<String, String> {
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(root)
        .args(args)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(input.as_bytes())
            .map_err(|e| format!("Couldn't run git: {e}"))?;
    }
    let output = child
        .wait_with_output()
        .map_err(|e| format!("Couldn't run git: {e}"))?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(stderr
            .lines()
            .map(str::trim)
            .rfind(|l| !l.is_empty() && !l.starts_with("hint:"))
            .unwrap_or("git failed")
            .to_string())
    }
}

/// Read before the edit: which branch the checkout is on and whether its tracked files are clean.
pub fn before_edit(root: &Path) -> Before {
    Before {
        branch: git(root, &["symbolic-ref", "--short", "-q", "HEAD"]).ok(),
        clean: git(root, &["status", "--porcelain", "--untracked-files=no"])
            .is_ok_and(|s| s.is_empty()),
    }
}

/// The repo's default branch: what `origin/HEAD` points at, else what the API saw, else what
/// `origin` says.
pub fn default_branch(root: &Path, seen: Option<&str>) -> Option<String> {
    if let Ok(head) = git(
        root,
        &["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"],
    ) && let Some(branch) = head.strip_prefix("origin/")
    {
        return Some(branch.to_string());
    }
    if let Some(seen) = seen {
        return Some(seen.to_string());
    }
    let listed = git(root, &["ls-remote", "--symref", "origin", "HEAD"]).ok()?;
    listed.lines().find_map(|line| {
        line.strip_prefix("ref: refs/heads/")?
            .split_once('\t')
            .map(|(branch, _)| branch.to_string())
    })
}

/// The branch a change to `file` goes on when it can't go on the default branch.
pub fn branch_for(file: &str) -> String {
    let stem = file.rsplit('/').next().unwrap_or(file);
    let stem = stem
        .strip_suffix(".yml")
        .or_else(|| stem.strip_suffix(".yaml"))
        .unwrap_or(stem);
    let slug: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("relayrunner/route-{}", slug.trim_matches('-'))
}

/// GitHub's page to open a pull request from `branch`.
pub fn compare_url(repo: &str, default: &str, branch: &str) -> String {
    format!("https://github.com/{repo}/compare/{default}...{branch}?expand=1")
}

fn same_text(a: &str, b: &str) -> bool {
    a.replace("\r\n", "\n") == b.replace("\r\n", "\n")
}

/// Commits `after` as `file` on top of `origin/<default>` and pushes it, as the module says.
/// `before` is the file as the edit found it, which must match the default branch's, so the commit
/// holds only the edit.
#[allow(clippy::too_many_arguments)]
pub fn push(
    root: &Path,
    repo: &str,
    default: &str,
    file: &str,
    before: &str,
    after: &str,
    message: &str,
    checkout: &Before,
) -> Result<Pushed, String> {
    let _ = git(root, &["fetch", "-q", "origin", default]);
    let remote = format!("refs/remotes/origin/{default}");
    let base = git(
        root,
        &[
            "rev-parse",
            "--verify",
            "-q",
            &format!("{remote}^{{commit}}"),
        ],
    )
    .map_err(|_| format!("Couldn't find {default} on origin."))?;
    let theirs =
        git_with(root, &["show", &format!("{base}:{file}")], None, &[]).unwrap_or_default();
    if !same_text(&theirs, before) {
        return Err(format!(
            "{file} on {default} isn't the same as in this checkout, so the change wasn't pushed."
        ));
    }
    let mode = git(root, &["ls-tree", &base, "--", file])
        .ok()
        .and_then(|line| line.split_whitespace().next().map(str::to_string))
        .unwrap_or_else(|| "100644".to_string());
    let blob = git_with(
        root,
        &["hash-object", "-w", "--stdin", &format!("--path={file}")],
        Some(after),
        &[],
    )?
    .trim()
    .to_string();
    let git_dir = PathBuf::from(git(root, &["rev-parse", "--absolute-git-dir"])?);
    let index = git_dir.join(format!("relayrunner-index-{}", std::process::id()));
    let env = [("GIT_INDEX_FILE", index.as_path())];
    let tree = git_with(root, &["read-tree", &base], None, &env)
        .and_then(|_| {
            git_with(
                root,
                &[
                    "update-index",
                    "--add",
                    "--cacheinfo",
                    &format!("{mode},{blob},{file}"),
                ],
                None,
                &env,
            )
        })
        .and_then(|_| git_with(root, &["write-tree"], None, &env))
        .map(|tree| tree.trim().to_string());
    let _ = std::fs::remove_file(&index);
    let commit = git(root, &["commit-tree", &tree?, "-p", &base, "-m", message])?;

    let head = git(root, &["rev-parse", "-q", "--verify", "HEAD"]).ok();
    if checkout.clean
        && checkout.branch.as_deref() == Some(default)
        && head.as_deref() == Some(base.as_str())
        && git(
            root,
            &[
                "push",
                "-q",
                "origin",
                &format!("{commit}:refs/heads/{default}"),
            ],
        )
        .is_ok()
    {
        // The checkout already has the file as committed, so this only moves the branch up.
        let _ = git(root, &["reset", "-q", &commit]);
        return Ok(Pushed::Default);
    }
    let first = branch_for(file);
    let mut refused = String::new();
    for n in 1..=3 {
        let branch = if n == 1 {
            first.clone()
        } else {
            format!("{first}-{n}")
        };
        match git(
            root,
            &[
                "push",
                "-q",
                "origin",
                &format!("{commit}:refs/heads/{branch}"),
            ],
        ) {
            Ok(_) => {
                return Ok(Pushed::Branch {
                    compare: compare_url(repo, default, &branch),
                    branch,
                });
            }
            Err(reason) => refused = reason,
        }
    }
    Err(format!("Couldn't push the change: {refused}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) -> String {
        git(dir, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    /// A bare `origin` with one commit on main, and a clone of it.
    fn clone_with(file: &str, source: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("rr-push-{}", fastrand::u64(..)));
        let origin = dir.join("origin.git");
        let work = dir.join("work");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&work).unwrap();
        run(&origin, &["init", "-q", "--bare", "-b", "main"]);
        run(&work, &["init", "-q", "-b", "main"]);
        for (key, value) in [
            ("user.name", "Test"),
            ("user.email", "test@example.com"),
            ("commit.gpgsign", "false"),
        ] {
            run(&work, &["config", key, value]);
        }
        run(
            &work,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        let path = work.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, source).unwrap();
        run(&work, &["add", "."]);
        run(&work, &["commit", "-q", "-m", "first"]);
        run(&work, &["push", "-q", "-u", "origin", "main"]);
        (dir, work)
    }

    const FILE: &str = ".github/workflows/ci.yml";

    #[test]
    fn pushes_to_the_default_branch_when_it_can() {
        let (dir, work) = clone_with(FILE, "on: push\n");
        let before = before_edit(&work);
        std::fs::write(work.join(FILE), "on: [push, workflow_dispatch]\n").unwrap();
        let pushed = push(
            &work,
            "acme/web",
            "main",
            FILE,
            "on: push\n",
            "on: [push, workflow_dispatch]\n",
            "ci: route ci.yml through RelayRunner",
            &before,
        )
        .unwrap();
        assert_eq!(pushed, Pushed::Default);
        let origin = dir.join("origin.git");
        assert_eq!(
            run(&origin, &["show", &format!("main:{FILE}")]),
            "on: [push, workflow_dispatch]"
        );
        assert_eq!(
            run(&origin, &["log", "-1", "--format=%s", "main"]),
            "ci: route ci.yml through RelayRunner"
        );
        // The checkout is level with it and has nothing left to commit.
        assert_eq!(run(&work, &["status", "--porcelain"]), "");
        assert_eq!(
            run(&work, &["rev-parse", "HEAD"]),
            run(&origin, &["rev-parse", "main"])
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pushes_a_branch_from_another_branch_or_a_dirty_checkout() {
        let (dir, work) = clone_with(FILE, "on: push\n");
        std::fs::write(work.join("README.md"), "hi\n").unwrap();
        run(&work, &["add", "README.md"]);
        run(&work, &["switch", "-q", "-c", "feature"]);
        let before = before_edit(&work);
        std::fs::write(work.join(FILE), "on: [push, workflow_dispatch]\n").unwrap();
        let pushed = push(
            &work,
            "acme/web",
            "main",
            FILE,
            "on: push\n",
            "on: [push, workflow_dispatch]\n",
            "ci: route ci.yml through RelayRunner",
            &before,
        )
        .unwrap();
        assert_eq!(
            pushed,
            Pushed::Branch {
                branch: "relayrunner/route-ci".into(),
                compare: "https://github.com/acme/web/compare/main...relayrunner/route-ci?expand=1"
                    .into(),
            }
        );
        let origin = dir.join("origin.git");
        // The branch holds only the workflow change, on top of main; main didn't move.
        assert_eq!(
            run(
                &origin,
                &["diff", "--name-only", "main", "relayrunner/route-ci"]
            ),
            FILE
        );
        assert_eq!(run(&origin, &["log", "-1", "--format=%s", "main"]), "first");
        // The checkout keeps its branch and its staged file.
        assert_eq!(run(&work, &["symbolic-ref", "--short", "HEAD"]), "feature");
        assert!(run(&work, &["status", "--porcelain"]).contains("A  README.md"));
        // A second time takes the next name instead of forcing over the first.
        let again = push(
            &work,
            "acme/web",
            "main",
            FILE,
            "on: push\n",
            "on: [push, workflow_dispatch]\n",
            "ci: route ci.yml through RelayRunner again",
            &before,
        )
        .unwrap();
        assert!(
            matches!(again, Pushed::Branch { branch, .. } if branch == "relayrunner/route-ci-2")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_when_the_default_branch_has_another_version() {
        let (dir, work) = clone_with(FILE, "on: push\n");
        let before = before_edit(&work);
        let refused = push(
            &work,
            "acme/web",
            "main",
            FILE,
            "on: pull_request\n",
            "on: [pull_request, workflow_dispatch]\n",
            "ci: route",
            &before,
        )
        .unwrap_err();
        assert!(refused.contains("isn't the same"), "{refused}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn names_branches_and_links() {
        assert_eq!(
            branch_for(".github/workflows/CI Build.yaml"),
            "relayrunner/route-ci-build"
        );
        assert_eq!(
            compare_url("acme/web", "main", "relayrunner/route-ci"),
            "https://github.com/acme/web/compare/main...relayrunner/route-ci?expand=1"
        );
        assert!(same_text("a\r\nb\r\n", "a\nb\n"));
    }
}
