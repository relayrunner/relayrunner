//! `relayrunner init` end to end: each folder in tests/init is a repo with one workflow,
//! `input.yml`. The test copies it into a fresh git checkout, runs the real binary with
//! `init --apply all --json` (plus the folder's `args`, if any), and compares what it wrote with
//! `expected.yml`, what it printed with `expected.json`, and the plan before it with `plan.txt`.
//! `<relay>` in the expected files stands for the relay version init pins.
//!
//! After a change to what init writes, regenerate them with `UPDATE_INIT_FIXTURES=1 cargo test
//! --test init`, and read the diff before committing it.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_relayrunner");

fn relay_ref() -> String {
    let json = include_str!("../../../packages/providers/src/relay.json");
    let value: serde_json::Value = serde_json::from_str(json).unwrap();
    value["relayRef"].as_str().unwrap().to_string()
}

fn run(repo: &Path, args: &[&str]) -> String {
    let out = Command::new(BIN)
        .args(args)
        .current_dir(repo)
        .env("NO_COLOR", "1")
        // A home of its own, so this machine's sign-in and VM setup don't change the plan.
        .env("HOME", repo.join(".home"))
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "relayrunner {args:?} failed:\n{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8(out.stdout).unwrap()
}

/// A fresh checkout holding the case's workflow, with no remote, so init never asks GitHub.
fn checkout(case: &Path) -> PathBuf {
    let name = case.file_name().unwrap().to_string_lossy();
    let repo = std::env::temp_dir().join(format!("rr-init-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(repo.join(".github/workflows")).unwrap();
    let git = Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo)
        .status()
        .unwrap();
    assert!(git.success());
    fs::copy(
        case.join("input.yml"),
        repo.join(".github/workflows/ci.yml"),
    )
    .unwrap();
    repo
}

/// The plan's jobs, one line each: verdict, job, and the reason or relay inputs.
fn plan_lines(json: &str) -> String {
    let plan: serde_json::Value = serde_json::from_str(json).unwrap();
    let mut out = String::new();
    for job in plan["jobs"].as_array().unwrap() {
        let verdict = job["verdict"].as_str().unwrap();
        let id = job["job"].as_str().unwrap();
        let detail = match verdict {
            "skipped" => job["reason"].as_str().unwrap_or_default().to_string(),
            "ready" => format!(
                "{} {} shape={}",
                job["provider"].as_str().unwrap_or_default(),
                job["label"].as_str().unwrap_or_default(),
                job["shape"]
            ),
            _ => String::new(),
        };
        out.push_str(&format!("{verdict:7} {id}: {detail}\n").replace(": \n", "\n"));
    }
    out
}

fn check(case: &Path, file: &str, actual: &str, update: bool) -> Option<String> {
    let path = case.join(file);
    let actual = actual.replace(&relay_ref(), "<relay>");
    if update {
        fs::write(&path, &actual).unwrap();
        return None;
    }
    let expected = fs::read_to_string(&path).unwrap_or_default();
    (expected != actual).then(|| {
        format!(
            "{}:\n--- expected\n{expected}\n--- actual\n{actual}",
            path.display()
        )
    })
}

#[test]
fn init_writes_what_each_fixture_expects() {
    let update = std::env::var_os("UPDATE_INIT_FIXTURES").is_some();
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/init");
    let mut cases: Vec<PathBuf> = fs::read_dir(&root)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("input.yml").exists())
        .collect();
    cases.sort();
    assert!(!cases.is_empty());

    let mut failures = Vec::new();
    for case in &cases {
        let repo = checkout(case);
        let extra = fs::read_to_string(case.join("args")).unwrap_or_default();
        let extra: Vec<&str> = extra.split_whitespace().collect();

        let plan = run(&repo, &[&["init", "--plan", "--json"][..], &extra].concat());
        failures.extend(check(case, "plan.txt", &plan_lines(&plan), update));

        let applied = run(
            &repo,
            &[&["init", "--apply", "all", "--json"][..], &extra].concat(),
        );
        failures.extend(check(case, "expected.json", &applied, update));
        let written = fs::read_to_string(repo.join(".github/workflows/ci.yml")).unwrap();
        failures.extend(check(case, "expected.yml", &written, update));

        // Run again: every job it routed reads back as routed, and nothing else changes.
        let replan = plan_lines(&run(&repo, &["init", "--plan", "--json"]));
        assert!(
            !replan.lines().any(|l| l.starts_with("ready")),
            "{}: jobs still ready after --apply all:\n{replan}",
            case.display()
        );
        let _ = fs::remove_dir_all(&repo);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
