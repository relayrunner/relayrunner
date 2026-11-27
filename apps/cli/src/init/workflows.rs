//! What `relayrunner init` knows about a repo's workflows: which jobs can route through the relay,
//! which already do, and which it leaves alone and why. Then the edit itself,
//! which works on the file's lines, so everything it doesn't add or change stays byte for byte,
//! and it checks that the result reads back routed.
//!
//! A routed job gets a relay job in front of it, the reusable workflow in relayrunner/actions,
//! and runs wherever the relay answers:
//!
//!   relay-test:
//!     uses: relayrunner/actions/.github/workflows/relay.yml@<relay version>
//!     with:
//!       os: linux
//!   test:
//!     needs: relay-test
//!     runs-on: ${{ needs.relay-test.outputs.runner }}
//!
//! The relay gets the job's shape, read from its old `runs-on` label: `os` always, `arch` when the
//! label isn't the OS's usual one, and `cpus` when it asks for more than a standard runner. Every
//! provider on the Router can then take it. With `exact`, it gets the old label instead, under its
//! provider's input, plus a `machine` input.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::LazyLock;
use yaml_rust2::{Yaml, YamlLoader, yaml::Hash};

/// What the CLI shares with @relayrunner/providers: the relay version `init` writes, the relay
/// workflow, and how each hosted provider's labels start. Bump the version with each
/// relayrunner/actions release, along with the skills and agent guide that show it (a test in
/// packages/providers checks them).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Relay {
    relay_ref: String,
    relay_workflow: String,
    label_prefixes: BTreeMap<String, Vec<String>>,
}

static RELAY: LazyLock<Relay> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../packages/providers/src/relay.json"
    ))
    .expect("relay.json parses")
});

pub fn relay_ref() -> &'static str {
    &RELAY.relay_ref
}

fn relay_workflow() -> &'static str {
    &RELAY.relay_workflow
}

/// The hosted provider a lowercase label asks for. A prefix ending in `-` also matches the bare
/// name.
fn hosted_provider_of(lower: &str) -> Option<&'static str> {
    RELAY.label_prefixes.iter().find_map(|(id, prefixes)| {
        prefixes
            .iter()
            .any(|p| lower.starts_with(p.as_str()) || p.strip_suffix('-') == Some(lower))
            .then_some(id.as_str())
    })
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Ready,
    Routed,
    Skipped,
}

#[derive(Clone, Debug, Serialize)]
pub struct WorkflowJob {
    /// Path relative to the repo root, such as `.github/workflows/ci.yml`.
    pub file: String,
    /// The job's id under `jobs:`.
    pub job: String,
    pub verdict: Verdict,
    /// Why a job is skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Things to check before running the job on a machine. The job can still be routed.
    pub warnings: Vec<String>,
    /// For a ready job: where its old `runs-on` label goes in the relay.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// For a ready job: the relay's `machine` input, written with `exact`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<&'static str>,
    /// For a ready job: what it needs, read from its label. The relay's inputs unless `exact`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shape: Option<Shape>,
}

/// A job's machine shape: the relay's `os`, `arch` and `cpus` inputs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Shape {
    /// `linux` or `macos`.
    pub os: &'static str,
    /// Only when the label isn't the OS's usual arch (x64 for Linux, Apple silicon for macOS).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arch: Option<&'static str>,
    /// Only when the label asks for more than a standard 2 CPU runner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cpus: Option<u32>,
}

impl Shape {
    /// Such as `Linux`, `Linux arm64, 4+ CPUs` or `macOS x64`.
    pub fn describe(&self) -> String {
        let mut out = if self.os == "macos" { "macOS" } else { "Linux" }.to_string();
        if let Some(arch) = self.arch {
            out.push(' ');
            out.push_str(arch);
        }
        if let Some(cpus) = self.cpus {
            out.push_str(&format!(", {cpus}+ CPUs"));
        }
        out
    }
}

/// CPUs a standard runner has. A label that asks for more gets `cpus`.
const STANDARD_CPUS: u32 = 2;

/// The shape a lowercase, non-Windows runner label asks for. `github` labels never carry a size
/// (GitHub's larger runners have names their owners pick), so only hosted providers' labels are
/// read for CPUs.
pub fn shape_of(lower: &str, provider: &str) -> Shape {
    let os = if lower.contains("macos") {
        "macos"
    } else {
        "linux"
    };
    let tokens: Vec<&str> = lower
        .split(['-', '_', '=', '/', ' '])
        .filter(|t| !t.is_empty())
        .collect();
    let arm = tokens
        .iter()
        .any(|t| t.starts_with("arm") || *t == "aarch64");
    let intel = tokens
        .iter()
        .any(|t| matches!(*t, "intel" | "x64" | "amd64" | "x86"));
    let arch = match os {
        "macos" if intel || (provider == "github" && macos_on_intel(&tokens)) => Some("x64"),
        "linux" if arm => Some("arm64"),
        _ => None,
    };
    let cpus = if provider == "github" {
        None
    } else {
        cpus_of(&tokens)
    }
    .filter(|&n| n > STANDARD_CPUS);
    Shape { os, arch, cpus }
}

/// GitHub's Intel macOS labels: macos-13 and older, and the `-large` ones.
fn macos_on_intel(tokens: &[&str]) -> bool {
    tokens.contains(&"large")
        || tokens
            .iter()
            .skip_while(|t| **t != "macos")
            .nth(1)
            .and_then(|v| v.parse::<u32>().ok())
            .is_some_and(|v| v <= 13)
}

/// The CPUs a hosted provider's label names, such as `4vcpu`, `8cpu`, `4-cores`, `4x`, `4x16`, or a
/// bare count at the end (`ubicloud-standard-4`, `depot-ubuntu-24.04-8`).
fn cpus_of(tokens: &[&str]) -> Option<u32> {
    let number = |t: &str| t.parse::<u32>().ok().filter(|n| (1..=512).contains(n));
    for (i, t) in tokens.iter().enumerate() {
        for suffix in ["vcpus", "vcpu", "cpus", "cpu", "cores", "core", "x"] {
            if let Some(n) = t.strip_suffix(suffix).and_then(number) {
                return Some(n);
            }
        }
        if let Some((n, mem)) = t.split_once('x')
            && let Some(n) = number(n)
            && mem.parse::<u32>().is_ok()
        {
            return Some(n);
        }
        if matches!(tokens.get(i + 1), Some(&"core" | &"cores"))
            && let Some(n) = number(t)
        {
            return Some(n);
        }
    }
    // A bare count: the last all-digit token, unless it's an OS version (ubuntu-22, macos-15).
    let os_names = ["ubuntu", "macos", "debian", "linux", "windows"];
    tokens.iter().enumerate().rev().find_map(|(i, t)| {
        let n = number(t)?;
        let after_os = i > 0 && os_names.contains(&tokens[i - 1]);
        (!after_os && t.len() <= 3 && i > 0).then_some(n)
    })
}

pub struct WorkflowFile {
    pub file: String,
    pub source: String,
}

#[derive(Serialize)]
pub struct FileError {
    pub file: String,
    pub message: String,
}

#[derive(Default)]
pub struct Options {
    /// The OS of the machine running `init`, for warnings about Linux-only steps.
    pub host_os: Option<&'static str>,
    /// The machine runs Linux jobs in a VM, which has Docker and Linux packages.
    pub vm: bool,
    /// Jobs the user said may run on a machine even though they look like deploy jobs, named by
    /// id or `file:id` (`--allow-deploy`).
    pub allow_deploy: Vec<String>,
}

/// A workflow's path without `.github/workflows/`, such as `ci.yml`.
pub fn short_file(file: &str) -> &str {
    file.strip_prefix(".github/workflows/").unwrap_or(file)
}

/// Whether `name` (an id, or `file:id` with the file's full path or just its name) names this job.
pub fn names_job(name: &str, file: &str, id: &str) -> bool {
    match name.rsplit_once(':') {
        Some((f, i)) => i == id && (f == file || f == short_file(file)),
        None => name == id,
    }
}

fn get<'a>(map: &'a Hash, key: &str) -> Option<&'a Yaml> {
    map.get(&Yaml::String(key.to_string()))
}

fn key_text(key: &Yaml) -> Option<String> {
    match key {
        Yaml::String(s) | Yaml::Real(s) => Some(s.clone()),
        Yaml::Integer(n) => Some(n.to_string()),
        Yaml::Boolean(b) => Some(b.to_string()),
        _ => None,
    }
}

pub fn analyze(files: &[WorkflowFile], options: &Options) -> (Vec<WorkflowJob>, Vec<FileError>) {
    let mut jobs = Vec::new();
    let mut errors = Vec::new();
    for WorkflowFile { file, source } in files {
        let docs = match YamlLoader::load_from_str(source) {
            Ok(docs) => docs,
            Err(e) => {
                errors.push(FileError {
                    file: file.clone(),
                    message: e.to_string().lines().next().unwrap_or_default().to_string(),
                });
                continue;
            }
        };
        let Some(Yaml::Hash(workflow)) = docs.into_iter().next() else {
            continue;
        };
        let Some(Yaml::Hash(all)) = get(&workflow, "jobs") else {
            continue;
        };
        let relays: Vec<String> = all
            .iter()
            .filter(|(_, job)| is_relay_job(job))
            .filter_map(|(id, _)| key_text(id))
            .collect();
        let reusable_only = only_workflow_call(get(&workflow, "on"));
        for (id, job) in all {
            let (Some(id), Yaml::Hash(job)) = (key_text(id), job) else {
                continue;
            };
            if relays.contains(&id) {
                continue;
            }
            jobs.push(judge(
                file,
                &id,
                job,
                &workflow,
                &relays,
                reusable_only,
                options,
            ));
        }
    }
    (jobs, errors)
}

/// True when any job already runs where a relay sends it.
pub fn is_set_up(jobs: &[WorkflowJob]) -> bool {
    jobs.iter().any(|job| job.verdict == Verdict::Routed)
}

fn judge(
    file: &str,
    id: &str,
    job: &Hash,
    workflow: &Hash,
    relays: &[String],
    reusable_only: bool,
    options: &Options,
) -> WorkflowJob {
    let base = WorkflowJob {
        file: file.to_string(),
        job: id.to_string(),
        verdict: Verdict::Skipped,
        reason: None,
        warnings: Vec::new(),
        provider: None,
        label: None,
        machine: None,
        shape: None,
    };
    let skip = |reason: &str| WorkflowJob {
        reason: Some(reason.to_string()),
        ..base.clone()
    };

    if matches!(get(job, "uses"), Some(Yaml::String(_))) {
        return skip("calls a reusable workflow");
    }
    if reusable_only {
        return skip("part of a reusable workflow; it runs wherever the calling workflow sends it");
    }
    let runs_on = match get(job, "runs-on") {
        None => return skip("has no runs-on"),
        Some(Yaml::String(s)) => s,
        Some(Yaml::Hash(_)) => return skip("runs-on is a runner group"),
        Some(_) => return skip("runs-on is a list of labels"),
    };
    if runs_on.contains("${{") {
        if relay_of(runs_on).is_some_and(|relay| relays.iter().any(|r| r == relay)) {
            return WorkflowJob {
                verdict: Verdict::Routed,
                ..base
            };
        }
        return skip("runs-on is an expression");
    }
    if let Some(Yaml::Hash(strategy)) = get(job, "strategy")
        && get(strategy, "matrix").is_some()
    {
        return skip("uses a matrix, and one relay can't serve every leg");
    }
    let mut warnings = Vec::new();
    if let Some(deploy) = deploy_signal(job, workflow) {
        if !options
            .allow_deploy
            .iter()
            .any(|name| names_job(name, file, id))
        {
            return skip(&format!("looks like a deploy job ({deploy})"));
        }
        warnings.push(format!(
            "looks like a deploy job ({deploy}), so the machine gets its secrets and cloud access"
        ));
    } else if requests_id_token(job, workflow) {
        warnings.push(
            "can request OIDC tokens (id-token: write): fine for a remote cache, but check it doesn't sign in to a cloud account".to_string(),
        );
    }

    let label = runs_on.trim();
    let lower = label.to_lowercase();
    let windows = lower.starts_with("windows-") || lower.contains("-windows-");
    if windows {
        return skip("Windows jobs can't run on machines yet");
    }
    let (provider, machine) = if let Some(hosted) = hosted_provider_of(&lower) {
        // Such as depot-macos-latest: only a Mac can stand in for it.
        (
            hosted,
            if lower.contains("macos") {
                "macOS"
            } else {
                "self-hosted"
            },
        )
    } else if lower.starts_with("ubuntu-") || lower.starts_with("macos-") {
        (
            "github",
            if lower.starts_with("macos-") {
                "macOS"
            } else {
                "self-hosted"
            },
        )
    } else if lower == "relayrunner" {
        return skip("already runs on RelayRunner");
    } else if lower == "self-hosted" {
        return skip("already runs on a self-hosted runner");
    } else {
        return skip(&format!(
            "{label} isn't a GitHub-hosted or hosted provider label"
        ));
    };

    warnings.extend(job_warnings(job, options));
    WorkflowJob {
        verdict: Verdict::Ready,
        warnings,
        provider: Some(provider),
        label: Some(label.to_string()),
        machine: Some(machine),
        shape: Some(shape_of(&lower, provider)),
        ..base
    }
}

/// The relay id in `${{ needs.<id>.outputs.runner }}`.
fn relay_of(runs_on: &str) -> Option<&str> {
    let inner = runs_on
        .trim()
        .strip_prefix("${{")?
        .strip_suffix("}}")?
        .trim();
    let id = inner
        .strip_prefix("needs.")?
        .strip_suffix(".outputs.runner")?;
    (!id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-'))
    .then_some(id)
}

fn is_relay_job(job: &Yaml) -> bool {
    let Yaml::Hash(job) = job else {
        return false;
    };
    matches!(get(job, "uses"), Some(Yaml::String(uses)) if uses.split('@').next() == Some(relay_workflow()))
}

fn only_workflow_call(on: Option<&Yaml>) -> bool {
    let is_call = |event: &Yaml| matches!(event, Yaml::String(s) if s == "workflow_call");
    match on {
        Some(event @ Yaml::String(_)) => is_call(event),
        Some(Yaml::Array(events)) => !events.is_empty() && events.iter().all(is_call),
        Some(Yaml::Hash(events)) => !events.is_empty() && events.keys().all(is_call),
        _ => false,
    }
}

/// Actions that trade the job's OIDC token for cloud credentials, or publish or sign a release
/// with it.
const OIDC_SIGN_INS: &[&str] = &[
    "aws-actions/configure-aws-credentials",
    "google-github-actions/auth",
    "azure/login",
    "hashicorp/vault-action",
    "pypa/gh-action-pypi-publish",
    "rust-lang/crates-io-auth-action",
    "actions/attest",
    "actions/attest-build-provenance",
    "sigstore/",
];

/// Commands that publish a package, which with `id-token: write` can use trusted publishing.
const PUBLISH_COMMANDS: &[&str] = &[
    "npm publish",
    "pnpm publish",
    "yarn npm publish",
    "changeset publish",
    "cargo publish",
    "twine upload",
];

/// The job's own permissions, or the workflow's when it sets none.
fn permissions<'a>(job: &'a Hash, workflow: &'a Hash) -> Option<&'a Yaml> {
    match get(job, "permissions") {
        None | Some(Yaml::Null) => get(workflow, "permissions"),
        set => set,
    }
}

fn requests_id_token(job: &Hash, workflow: &Hash) -> bool {
    matches!(permissions(job, workflow), Some(Yaml::Hash(p)) if matches!(get(p, "id-token"), Some(Yaml::String(s)) if s == "write"))
}

/// What the job does with an OIDC token that makes it a deploy: an action that signs in to a
/// cloud or registry with it, or a publish command. A token alone, such as for a remote cache,
/// isn't a deploy.
fn oidc_sign_in(job: &Hash) -> Option<String> {
    let Some(Yaml::Array(steps)) = get(job, "steps") else {
        return None;
    };
    steps.iter().find_map(|step| {
        let Yaml::Hash(step) = step else { return None };
        if let Some(Yaml::String(uses)) = get(step, "uses") {
            let action = uses.split('@').next().unwrap_or_default();
            let known = OIDC_SIGN_INS.iter().any(|known| {
                action.eq_ignore_ascii_case(known)
                    || (known.ends_with('/') && action.to_lowercase().starts_with(known))
            });
            if known {
                return Some(action.to_string());
            }
        }
        if let Some(Yaml::String(run)) = get(step, "run") {
            return PUBLISH_COMMANDS
                .iter()
                .find(|command| runs_command(run, command))
                .map(|command| command.to_string());
        }
        None
    })
}

fn deploy_signal(job: &Hash, workflow: &Hash) -> Option<String> {
    if get(job, "environment").is_some() {
        return Some("environment".into());
    }
    if matches!(permissions(job, workflow), Some(Yaml::String(s)) if s == "write-all") {
        return Some("write-all permissions".into());
    }
    if requests_id_token(job, workflow)
        && let Some(sign_in) = oidc_sign_in(job)
    {
        return Some(format!("id-token: write with {sign_in}"));
    }
    secret_in_map(job).map(|secret| format!("uses {secret}"))
}

/// The first `secrets.NAME` other than GITHUB_TOKEN anywhere in a job, keys included.
fn secret_in_map(map: &Hash) -> Option<String> {
    map.iter().find_map(|(k, v)| {
        key_text(k)
            .and_then(|k| secret_in(&k))
            .or_else(|| first_secret(v))
    })
}

fn first_secret(node: &Yaml) -> Option<String> {
    match node {
        Yaml::String(s) => secret_in(s),
        Yaml::Array(items) => items.iter().find_map(first_secret),
        Yaml::Hash(map) => secret_in_map(map),
        _ => None,
    }
}

fn is_word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}

fn secret_in(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(at) = text[from..].find("secrets.").map(|i| i + from) {
        from = at + 1;
        if at > 0 && is_word(bytes[at - 1]) {
            continue;
        }
        let start = at + "secrets.".len();
        let end = bytes[start..]
            .iter()
            .position(|&c| !is_word(c))
            .map_or(bytes.len(), |i| start + i);
        let name = &text[start..end];
        if name.is_empty() || bytes[start].is_ascii_digit() || name == "GITHUB_TOKEN" {
            continue;
        }
        return Some(format!("secrets.{name}"));
    }
    None
}

/// Whether a script installs packages with apt-get, apt, yum, dnf or apk.
/// The offsets in a script where a command could start: its start, or after a space or separator.
fn command_starts(script: &str) -> impl Iterator<Item = usize> + '_ {
    let bytes = script.as_bytes();
    (0..bytes.len()).filter(move |&i| {
        i == 0
            || matches!(
                bytes[i - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'('
            )
    })
}

/// Whether a script runs `command` (such as `npm publish`) as words of their own.
fn runs_command(script: &str, command: &str) -> bool {
    command_starts(script).any(|i| {
        script[i..]
            .strip_prefix(command)
            .is_some_and(|tail| tail.bytes().next().is_none_or(|c| !is_word(c)))
    })
}

fn installs_linux_packages(script: &str) -> bool {
    command_starts(script).any(|i| {
        let rest = &script[i..];
        ["apt-get", "apt", "yum", "dnf", "apk"].iter().any(|tool| {
            let Some(after) = rest.strip_prefix(tool) else {
                return false;
            };
            let words = after.trim_start_matches([' ', '\t', '\n', '\r']);
            if words.len() == after.len() {
                return false;
            }
            ["install", "update", "add"].iter().any(|verb| {
                words
                    .strip_prefix(verb)
                    .is_some_and(|tail| tail.bytes().next().is_none_or(|c| !is_word(c)))
            })
        })
    })
}

fn job_warnings(job: &Hash, options: &Options) -> Vec<String> {
    let mut warnings = Vec::new();
    let docker = !options.vm;
    if docker && get(job, "services").is_some() {
        warnings.push("uses services, which need Docker on the machine".to_string());
    }
    if docker && get(job, "container").is_some() {
        warnings.push("runs in a container, which needs Docker on the machine".to_string());
    }
    let mut provider_actions: Vec<&str> = Vec::new();
    let mut packages = false;
    if let Some(Yaml::Array(steps)) = get(job, "steps") {
        for step in steps {
            let Yaml::Hash(step) = step else { continue };
            if let Some(Yaml::String(run)) = get(step, "run")
                && installs_linux_packages(run)
            {
                packages = true;
            }
            if let Some(Yaml::String(uses)) = get(step, "uses") {
                let action = uses.split('@').next().unwrap_or_default();
                if action.starts_with("useblacksmith/") && !provider_actions.contains(&action) {
                    provider_actions.push(action);
                }
                if docker && action.starts_with("docker://") {
                    warnings.push(
                        "runs a Docker action, which needs Docker on the machine".to_string(),
                    );
                }
            }
        }
    }
    if packages && !options.vm && options.host_os != Some("linux") {
        warnings.push(if options.host_os == Some("macos") {
            "installs Linux packages (apt-get, yum or apk), which macOS doesn't have".to_string()
        } else {
            "installs Linux packages (apt-get, yum or apk)".to_string()
        });
    }
    for action in provider_actions {
        warnings.push(format!(
            "uses {action}, which is made for Blacksmith runners"
        ));
    }
    warnings
}

/// The relay inputs a ready job gets: its shape, or with `exact`, its machine and old label.
pub fn relay_inputs(job: &WorkflowJob, exact: bool) -> Option<Vec<(String, String)>> {
    let (Verdict::Ready, Some(provider), Some(label)) = (job.verdict, job.provider, &job.label)
    else {
        return None;
    };
    if exact {
        return Some(vec![
            (
                "machine".into(),
                job.machine.unwrap_or("self-hosted").into(),
            ),
            (provider.into(), label.clone()),
        ]);
    }
    let shape = job.shape.as_ref()?;
    let mut inputs = vec![("os".to_string(), shape.os.to_string())];
    if let Some(arch) = shape.arch {
        inputs.push(("arch".into(), arch.into()));
    }
    if let Some(cpus) = shape.cpus {
        inputs.push(("cpus".into(), cpus.to_string()));
    }
    Some(inputs)
}

/// Routes the given jobs of one workflow file through the relay, and returns the new contents.
/// Each job must have come back ready from `analyze` for this same source. Each relay gets the
/// job's shape, or with `exact`, its old label. Fails, with why, on a layout it can't edit safely,
/// such as jobs written inline.
pub fn route_jobs(source: &str, jobs: &[WorkflowJob], exact: bool) -> Result<String, String> {
    let mut text = source.to_string();
    for job in jobs {
        let inputs =
            relay_inputs(job, exact).ok_or_else(|| format!("{} isn't ready to route.", job.job))?;
        text = route_job(&text, &job.job, &inputs)?;
    }
    // The edit is only as good as what GitHub will read back from it.
    let (after, errors) = analyze(
        &[WorkflowFile {
            file: String::new(),
            source: text.clone(),
        }],
        &Options::default(),
    );
    let routed = |id: &str| {
        after
            .iter()
            .any(|j| j.job == id && j.verdict == Verdict::Routed)
    };
    if !errors.is_empty() || !jobs.iter().all(|j| routed(&j.job)) {
        return Err("its layout isn't one init can edit safely".into());
    }
    Ok(text)
}

/// A line's text without its line ending.
fn text_of(line: &str) -> &str {
    line.trim_end_matches(['\n', '\r'])
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start_matches(' ').len()
}

fn blank(line: &str) -> bool {
    text_of(line).trim().is_empty()
}

fn comment(line: &str) -> bool {
    text_of(line).trim_start().starts_with('#')
}

/// A mapping key at the start of `text` (after its indent): the key, and where its value starts.
fn split_key(text: &str) -> Option<(String, usize)> {
    let lead = text.len() - text.trim_start().len();
    let s = &text[lead..];
    let (key, after) = match s.chars().next()? {
        quote @ ('"' | '\'') => {
            let close = s[1..].find(quote)? + 1;
            (s[1..close].to_string(), close + 1)
        }
        '-' if s.starts_with("- ") || s == "-" => return None,
        _ => {
            let colon = s
                .match_indices(':')
                .find(|(i, _)| {
                    s[i + 1..]
                        .chars()
                        .next()
                        .is_none_or(|c| c == ' ' || c == '\t')
                })?
                .0;
            (s[..colon].trim_end().to_string(), colon)
        }
    };
    let rest = &s[after..];
    let rest = rest.trim_start();
    rest.starts_with(':').then(|| {
        let colon = text.len() - rest.len();
        (key, colon + 1)
    })
}

/// Where a scalar value starts and ends on a line, from `from`, leaving out a trailing comment.
/// None when the value isn't on this line.
fn scalar_span(text: &str, from: usize) -> Option<(usize, usize)> {
    let start = from + (text[from..].len() - text[from..].trim_start().len());
    let value = &text[start..];
    match value.chars().next()? {
        '#' => None,
        quote @ ('"' | '\'') => {
            let close = value[1..].find(quote)? + 1;
            Some((start, start + close + 1))
        }
        _ => {
            let end = value
                .find(" #")
                .or_else(|| value.find("\t#"))
                .unwrap_or(value.len());
            Some((start, start + value[..end].trim_end().len()))
        }
    }
}

/// A plain YAML scalar when that reads back the same, otherwise a double-quoted one.
fn yaml_scalar(value: &str) -> String {
    let plain = !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./=+".contains(c))
        && !value.starts_with(['-', '.']);
    if plain {
        value.to_string()
    } else {
        serde_json::to_string(value).unwrap_or_default()
    }
}

fn route_job(source: &str, id: &str, inputs: &[(String, String)]) -> Result<String, String> {
    let eol = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = source.split_inclusive('\n').map(String::from).collect();
    let unterminated = lines.last().is_some_and(|l| !l.ends_with('\n'));
    if unterminated && let Some(last) = lines.last_mut() {
        last.push_str(eol);
    }

    let jobs_at = lines
        .iter()
        .position(|l| {
            text_of(l)
                .strip_prefix("jobs:")
                .is_some_and(|rest| rest.trim().is_empty() || rest.trim().starts_with('#'))
        })
        .ok_or("its jobs aren't written as a block init can edit")?;

    // Each job's key line, from the indent of the first one to the end of the jobs map.
    let mut keys: Vec<(usize, String, bool)> = Vec::new();
    let mut job_indent = None;
    let mut end = lines.len();
    for (i, line) in lines.iter().enumerate().skip(jobs_at + 1) {
        if blank(line) || comment(line) {
            continue;
        }
        let indent = indent_of(line);
        let ji = *job_indent.get_or_insert(indent);
        if indent == 0 || indent < ji {
            end = i;
            break;
        }
        if indent == ji {
            let text = text_of(line);
            let (key, value_at) =
                split_key(text).ok_or("its jobs aren't written as a block init can edit")?;
            let rest = text[value_at..].trim();
            keys.push((i, key, rest.is_empty() || rest.starts_with('#')));
        }
    }
    let ji = job_indent.unwrap_or(0);
    let index = keys
        .iter()
        .position(|(_, key, _)| key == id)
        .ok_or_else(|| format!("no job {id} in this workflow"))?;
    let (key_line, _, block) = keys[index];
    if !block {
        return Err(format!("{id} is written inline"));
    }
    let body_end = keys.get(index + 1).map_or(end, |k| k.0);
    let body_indent = (key_line + 1..body_end)
        .map(|i| &lines[i])
        .find(|l| !blank(l) && !comment(l))
        .map(|l| indent_of(l))
        .filter(|&bi| bi > ji)
        .ok_or_else(|| format!("{id} has no body"))?;
    let step = body_indent - ji;
    let property = |lines: &[String], name: &str| {
        (key_line + 1..body_end).find_map(|i| {
            let line = &lines[i];
            if blank(line) || comment(line) || indent_of(line) != body_indent {
                return None;
            }
            split_key(text_of(line)).and_then(|(key, at)| (key == name).then_some((i, at)))
        })
    };

    let taken: Vec<&str> = keys.iter().map(|k| k.1.as_str()).collect();
    let wanted = format!("relay-{id}");
    let relay = if taken.contains(&wanted.as_str()) {
        (2..)
            .map(|n| format!("{wanted}-{n}"))
            .find(|candidate| !taken.contains(&candidate.as_str()))
            .unwrap_or_default()
    } else {
        wanted
    };

    // runs-on points at the relay, keeping any comment after the old value.
    let (runs_on, at) =
        property(&lines, "runs-on").ok_or_else(|| format!("{id} has no runs-on"))?;
    let target = format!("${{{{ needs.{relay}.outputs.runner }}}}");
    let text = text_of(&lines[runs_on]).to_string();
    let (start, stop) =
        scalar_span(&text, at).ok_or_else(|| format!("{id}'s runs-on spans lines"))?;
    lines[runs_on] = format!("{}{target}{}{eol}", &text[..start], &text[stop..]);

    // needs gets the relay too: a new line, one more in a list, or a single need made a list.
    match property(&lines, "needs") {
        None => lines.insert(
            runs_on,
            format!("{}needs: {relay}{eol}", " ".repeat(body_indent)),
        ),
        Some((line, at)) => {
            let text = text_of(&lines[line]).to_string();
            let value = text[at..].trim_start();
            let start = text.len() - value.len();
            if value.starts_with('[') {
                let close = text
                    .rfind(']')
                    .filter(|&c| c > start)
                    .ok_or_else(|| format!("{id}'s needs list spans lines"))?;
                let inner = text[start + 1..close].trim_end();
                let joined = if inner.trim().is_empty() {
                    format!("{}[{relay}", &text[..start])
                } else {
                    format!("{}{inner}, {relay}", &text[..=start])
                };
                lines[line] = format!("{joined}{}{eol}", &text[close..]);
            } else if value.is_empty() || value.starts_with('#') {
                // A block list on the lines below: one more item after the last.
                let mut item_indent = None;
                let mut last = None;
                for (i, l) in lines.iter().enumerate().take(body_end).skip(line + 1) {
                    if blank(l) || comment(l) {
                        continue;
                    }
                    let indent = indent_of(l);
                    let item = text_of(l).trim_start();
                    let is_item = item == "-" || item.starts_with("- ");
                    match item_indent {
                        None if is_item && indent >= body_indent => item_indent = Some(indent),
                        None => break,
                        Some(ii) if indent > ii || (indent == ii && is_item) => {}
                        Some(_) => break,
                    }
                    last = Some(i);
                }
                let (Some(ii), Some(last)) = (item_indent, last) else {
                    return Err(format!("{id}'s needs isn't a list init can edit"));
                };
                lines.insert(last + 1, format!("{}- {relay}{eol}", " ".repeat(ii)));
            } else if value.starts_with('{') {
                return Err(format!("{id}'s needs isn't a list init can edit"));
            } else {
                let (s, e) = scalar_span(&text, at).unwrap_or((start, text.len()));
                lines[line] = format!(
                    "{}[{}, {relay}]{}{eol}",
                    &text[..s],
                    &text[s..e],
                    &text[e..]
                );
            }
        }
    }

    // The relay goes in front of the job, after any comment above it, with a blank line between
    // them, and one before it unless it's the first job.
    let pad = |n: usize| " ".repeat(n);
    let mut block = vec![
        format!("{}{relay}:{eol}", pad(ji)),
        format!(
            "{}uses: {}@{}{eol}",
            pad(ji + step),
            relay_workflow(),
            relay_ref()
        ),
        format!("{}with:{eol}", pad(ji + step)),
    ];
    block.extend(
        inputs.iter().map(|(key, value)| {
            format!("{}{key}: {}{eol}", pad(ji + 2 * step), yaml_scalar(value))
        }),
    );
    block.push(eol.to_string());
    let mut above = key_line;
    while above > jobs_at + 1 && comment(&lines[above - 1]) {
        above -= 1;
    }
    lines.splice(key_line..key_line, block);
    if index > 0 && !blank(&lines[above - 1]) {
        lines.insert(above, eol.to_string());
    }

    let mut out = lines.concat();
    if unterminated {
        out.truncate(out.len() - eol.len());
    }
    Ok(out)
}

/// The events a workflow's `on:` lists, or None when it can't be read.
fn events_of(source: &str) -> Option<Vec<String>> {
    let docs = YamlLoader::load_from_str(source).ok()?;
    let Some(Yaml::Hash(workflow)) = docs.into_iter().next() else {
        return None;
    };
    Some(match get(&workflow, "on")? {
        Yaml::String(event) => vec![event.clone()],
        Yaml::Array(events) => events.iter().filter_map(key_text).collect(),
        Yaml::Hash(events) => events.keys().filter_map(key_text).collect(),
        _ => return None,
    })
}

/// The workflow's `name:`, when it has one.
pub fn workflow_name(source: &str) -> Option<String> {
    let docs = YamlLoader::load_from_str(source).ok()?;
    let Some(Yaml::Hash(workflow)) = docs.into_iter().next() else {
        return None;
    };
    match get(&workflow, "name")? {
        Yaml::String(name) => Some(name.clone()),
        _ => None,
    }
}

/// Whether the workflow can be started on demand, with `workflow_dispatch` among its triggers.
pub fn has_dispatch(source: &str) -> bool {
    events_of(source).is_some_and(|events| events.iter().any(|e| e == "workflow_dispatch"))
}

/// Adds `workflow_dispatch` to the workflow's `on:`, whether it's one event (`on: push`), a list
/// or a map, and returns the new contents. Like `route_jobs`, it edits lines, so the rest stays
/// byte for byte, and checks the result reads back with every old trigger and the new one.
pub fn add_dispatch(source: &str) -> Result<String, String> {
    let cant = || "its triggers aren't written in a way init can edit".to_string();
    let before = events_of(source).ok_or_else(cant)?;
    if before.iter().any(|e| e == "workflow_dispatch") {
        return Ok(source.to_string());
    }
    let eol = if source.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    };
    let mut lines: Vec<String> = source.split_inclusive('\n').map(String::from).collect();
    let unterminated = lines.last().is_some_and(|l| !l.ends_with('\n'));
    if unterminated && let Some(last) = lines.last_mut() {
        last.push_str(eol);
    }
    let (on_at, value_at) = lines
        .iter()
        .enumerate()
        .find_map(|(i, line)| {
            if indent_of(line) != 0 || blank(line) || comment(line) {
                return None;
            }
            split_key(text_of(line)).and_then(|(key, at)| (key == "on").then_some((i, at)))
        })
        .ok_or_else(cant)?;
    let text = text_of(&lines[on_at]).to_string();
    let value = text[value_at..].trim_start();
    let start = text.len() - value.len();
    if value.starts_with('[') {
        // on: [push, pull_request]
        let close = text.rfind(']').filter(|&c| c > start).ok_or_else(cant)?;
        let inner = text[start + 1..close].trim_end();
        let joined = if inner.trim().is_empty() {
            format!("{}[workflow_dispatch", &text[..start])
        } else {
            format!("{}{inner}, workflow_dispatch", &text[..=start])
        };
        lines[on_at] = format!("{joined}{}{eol}", &text[close..]);
    } else if value.starts_with('{') {
        return Err(cant());
    } else if value.is_empty() || value.starts_with('#') {
        // A list or a map on the lines below.
        let first = (on_at + 1..lines.len())
            .find(|&i| !blank(&lines[i]) && !comment(&lines[i]))
            .ok_or_else(cant)?;
        let indent = indent_of(&lines[first]);
        let item = text_of(&lines[first]).trim_start();
        if item == "-" || item.starts_with("- ") {
            // One more item after the list's last line.
            let mut last = first;
            for (i, line) in lines.iter().enumerate().skip(first + 1) {
                if blank(line) || comment(line) {
                    continue;
                }
                let at = indent_of(line);
                let text = text_of(line).trim_start();
                if at > indent || (at == indent && (text == "-" || text.starts_with("- "))) {
                    last = i;
                } else {
                    break;
                }
            }
            lines.insert(
                last + 1,
                format!("{}- workflow_dispatch{eol}", " ".repeat(indent)),
            );
        } else if indent > 0 {
            // A map: the new event goes first, so nothing under the others moves.
            lines.insert(
                first,
                format!("{}workflow_dispatch:{eol}", " ".repeat(indent)),
            );
        } else {
            return Err(cant());
        }
    } else {
        // on: push
        let (s, e) = scalar_span(&text, value_at).ok_or_else(cant)?;
        lines[on_at] = format!(
            "{}[{}, workflow_dispatch]{}{eol}",
            &text[..s],
            &text[s..e],
            &text[e..]
        );
    }
    let mut out = lines.concat();
    if unterminated {
        out.truncate(out.len() - eol.len());
    }
    let after = events_of(&out).ok_or_else(cant)?;
    let kept = before.iter().all(|e| after.contains(e));
    if !kept || after.len() != before.len() + 1 || !has_dispatch(&out) {
        return Err(cant());
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = ".github/workflows/ci.yml";

    #[test]
    fn adds_workflow_dispatch_to_each_form_of_on() {
        let jobs = "jobs:\n  test:\n    runs-on: ubuntu-latest\n";
        for (on, want) in [
            ("on: push\n", "on: [push, workflow_dispatch]\n"),
            (
                "on: push  # every push\n",
                "on: [push, workflow_dispatch]  # every push\n",
            ),
            ("on: \"push\"\n", "on: [\"push\", workflow_dispatch]\n"),
            (
                "on: [push, pull_request]\n",
                "on: [push, pull_request, workflow_dispatch]\n",
            ),
            (
                "on:\n  - push\n  - pull_request\n",
                "on:\n  - push\n  - pull_request\n  - workflow_dispatch\n",
            ),
            ("on:\n- push\n", "on:\n- push\n- workflow_dispatch\n"),
            (
                "on:\n  # main only\n  push:\n    branches: [main]\n  pull_request:\n",
                "on:\n  # main only\n  workflow_dispatch:\n  push:\n    branches: [main]\n  pull_request:\n",
            ),
        ] {
            let source = format!("name: CI\n{on}{jobs}");
            let out = add_dispatch(&source).unwrap();
            assert_eq!(out, format!("name: CI\n{want}{jobs}"), "{on}");
            assert!(has_dispatch(&out));
        }
        // Already there, nothing changes; CRLF and a missing last newline stay as they were.
        let has = "on:\n  workflow_dispatch:\n  push:\njobs: {}\n";
        assert_eq!(add_dispatch(has).unwrap(), has);
        assert_eq!(
            add_dispatch("on: push\r\njobs: {}").unwrap(),
            "on: [push, workflow_dispatch]\r\njobs: {}"
        );
        assert!(add_dispatch("on: {push: {branches: [main]}}\njobs: {}\n").is_err());
        assert!(add_dispatch("jobs: {}\n").is_err());
        assert_eq!(workflow_name("name: CI\non: push\n").as_deref(), Some("CI"));
        assert_eq!(workflow_name("on: push\n"), None);
    }

    fn judge(source: &str, host_os: &'static str, vm: bool) -> Vec<WorkflowJob> {
        let (jobs, errors) = analyze(
            &[WorkflowFile {
                file: FILE.into(),
                source: source.into(),
            }],
            &Options {
                host_os: Some(host_os),
                vm,
                ..Options::default()
            },
        );
        assert!(errors.is_empty(), "{}", errors[0].message);
        jobs
    }

    fn one(source: &str) -> WorkflowJob {
        let mut jobs = judge(source, "macos", false);
        assert_eq!(jobs.len(), 1);
        jobs.remove(0)
    }

    fn job(body: &str) -> String {
        format!("on: push\njobs:\n  test:\n{body}")
    }

    #[test]
    fn ready_labels() {
        let j = one(&job(
            "    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n",
        ));
        assert_eq!(j.verdict, Verdict::Ready);
        assert_eq!(
            (j.provider, j.label.as_deref(), j.machine),
            (Some("github"), Some("ubuntu-latest"), Some("self-hosted"))
        );
        assert!(j.warnings.is_empty());
        assert_eq!(one(&job("    runs-on: macos-15\n")).machine, Some("macOS"));
        let b = one(&job(
            "    runs-on: blacksmith-2vcpu-ubuntu-2404\n    steps:\n      - uses: useblacksmith/checkout@v1\n",
        ));
        assert_eq!(b.provider, Some("blacksmith"));
        assert_eq!(
            b.warnings,
            ["uses useblacksmith/checkout, which is made for Blacksmith runners"]
        );
        let d = one(&job("    runs-on: depot-macos-latest\n"));
        assert_eq!((d.provider, d.machine), (Some("depot"), Some("macOS")));
        assert_eq!(hosted_provider_of("ubicloud"), Some("ubicloud"));
        assert_eq!(hosted_provider_of("celesto"), Some("celesto"));
        assert_eq!(hosted_provider_of("instabox-medium"), Some("instabox"));
        assert_eq!(hosted_provider_of("groundbox"), Some("groundbox"));
        assert_eq!(hosted_provider_of("boathouse"), None);
    }

    #[test]
    fn skips_with_reasons() {
        for (body, reason) in [
            (
                "    strategy:\n      matrix:\n        node: [20, 22]\n    runs-on: ubuntu-latest\n",
                "matrix",
            ),
            (
                "    runs-on: ${{ github.event_name == 'push' && 'ubuntu-latest' || 'ubuntu-24.04' }}\n",
                "expression",
            ),
            ("    runs-on: [self-hosted, linux]\n", "list of labels"),
            ("    runs-on:\n      group: big\n", "runner group"),
            (
                "    uses: ./.github/workflows/shared.yml\n",
                "reusable workflow",
            ),
            (
                "    runs-on: ubuntu-latest\n    environment: production\n",
                "deploy job (environment)",
            ),
            (
                "    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n",
                "deploy job (id-token: write with aws-actions/configure-aws-credentials)",
            ),
            (
                "    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n    steps:\n      - run: npm publish --provenance\n",
                "deploy job (id-token: write with npm publish)",
            ),
            (
                "    runs-on: ubuntu-latest\n    steps:\n      - run: deploy\n        env:\n          TOKEN: ${{ secrets.DEPLOY_TOKEN }}\n",
                "secrets.DEPLOY_TOKEN",
            ),
            ("    runs-on: windows-latest\n", "Windows"),
            ("    runs-on: relayrunner\n", "already runs on RelayRunner"),
            ("    runs-on: self-hosted\n", "self-hosted"),
            (
                "    runs-on: my-big-runner\n",
                "isn't a GitHub-hosted or hosted provider label",
            ),
            ("    steps: []\n", "no runs-on"),
        ] {
            let j = one(&job(body));
            assert_eq!(j.verdict, Verdict::Skipped, "{body}");
            assert!(j.reason.as_deref().unwrap().contains(reason), "{body}");
        }
        let token = one(&job(
            "    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr list\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n",
        ));
        assert_eq!(token.verdict, Verdict::Ready);
        let workflow_level = one(
            "on: push\npermissions:\n  id-token: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: google-github-actions/auth@v2\n",
        );
        assert!(workflow_level.reason.unwrap().contains("id-token"));
        let reusable = one("on: workflow_call\njobs:\n  test:\n    runs-on: ubuntu-latest\n");
        assert!(reusable.reason.unwrap().contains("reusable workflow"));
    }

    /// An OIDC token on its own, such as for a remote cache, is a warning, not a deploy.
    #[test]
    fn id_token_alone_is_not_a_deploy() {
        for source in [
            job(
                "    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - run: pnpm turbo test\n",
            ),
            "on: push\npermissions:\n  id-token: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n"
                .to_string(),
        ] {
            let j = one(&source);
            assert_eq!(j.verdict, Verdict::Ready, "{source}");
            assert!(j.warnings[0].contains("id-token: write"), "{source}");
        }
    }

    #[test]
    fn routes_a_deploy_job_the_user_allows() {
        let source = job(
            "    runs-on: ubuntu-latest\n    environment: production\n    steps:\n      - run: echo hi\n",
        );
        let allowed = |names: &[&str]| {
            analyze(
                &[WorkflowFile {
                    file: FILE.into(),
                    source: source.clone(),
                }],
                &Options {
                    allow_deploy: names.iter().map(|n| n.to_string()).collect(),
                    ..Options::default()
                },
            )
            .0
            .remove(0)
        };
        for names in [
            &["test"][..],
            &["ci.yml:test"],
            &[".github/workflows/ci.yml:test"],
        ] {
            let j = allowed(names);
            assert_eq!(j.verdict, Verdict::Ready, "{names:?}");
            assert!(j.warnings[0].contains("deploy job (environment)"));
        }
        assert_eq!(allowed(&["other.yml:test"]).verdict, Verdict::Skipped);
        assert_eq!(allowed(&["lint"]).verdict, Verdict::Skipped);
        // It only lifts the deploy check.
        let matrix = analyze(
            &[WorkflowFile {
                file: FILE.into(),
                source: job(
                    "    strategy:\n      matrix:\n        node: [20, 22]\n    runs-on: ubuntu-latest\n    environment: production\n",
                ),
            }],
            &Options {
                allow_deploy: vec!["test".into()],
                ..Options::default()
            },
        )
        .0;
        assert_eq!(matrix[0].verdict, Verdict::Skipped);
    }

    #[test]
    fn warnings() {
        let source = job(
            "    runs-on: ubuntu-latest\n    container: node:22\n    services:\n      db:\n        image: postgres\n    steps:\n      - run: sudo apt-get install -y jq\n",
        );
        assert_eq!(
            judge(&source, "macos", false)[0].warnings,
            [
                "uses services, which need Docker on the machine",
                "runs in a container, which needs Docker on the machine",
                "installs Linux packages (apt-get, yum or apk), which macOS doesn't have",
            ]
        );
        assert_eq!(judge(&source, "linux", false)[0].warnings.len(), 2);
        assert!(judge(&source, "macos", true)[0].warnings.is_empty());
        assert!(installs_linux_packages("cd x && apk add git"));
        assert!(!installs_linux_packages("echo apt-getter install"));
        assert!(!installs_linux_packages("snap install"));
        assert!(runs_command("pnpm build && npm publish", "npm publish"));
        assert!(!runs_command("pnpm publish", "npm publish"));
        assert!(!runs_command("npm publisher", "npm publish"));
    }

    #[test]
    fn routed_jobs_and_relays() {
        let jobs = judge(
            "on: push
jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@v1.0.0-beta.2
    with:
      machine: self-hosted
      github: ubuntu-latest
  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }}
  lint:
    runs-on: ubuntu-latest
",
            "macos",
            false,
        );
        let verdicts: Vec<_> = jobs.iter().map(|j| (j.job.as_str(), j.verdict)).collect();
        assert_eq!(
            verdicts,
            [("test", Verdict::Routed), ("lint", Verdict::Ready)]
        );
        assert!(is_set_up(&jobs));
    }

    #[test]
    fn reports_a_file_it_cant_parse() {
        let (jobs, errors) = analyze(
            &[
                WorkflowFile {
                    file: "bad.yml".into(),
                    source: "jobs: [\n".into(),
                },
                WorkflowFile {
                    file: FILE.into(),
                    source: job("    runs-on: ubuntu-latest\n"),
                },
            ],
            &Options::default(),
        );
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].file, "bad.yml");
        assert_eq!(jobs.len(), 1);
    }

    const SOURCE: &str = "name: CI

# Runs on every push.
on:
  push:
  workflow_dispatch:

jobs:
  test:
    runs-on: ubuntu-latest # keep this comment
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint

  # Builds after both checks pass.
  build:
    needs: [test, lint]
    runs-on: ubuntu-24.04
    steps:
      - run: npm run build
";

    #[test]
    fn adds_a_relay_in_front_of_each_job() {
        let jobs = judge(SOURCE, "macos", false);
        let out = route_jobs(SOURCE, &[jobs[0].clone(), jobs[2].clone()], false).unwrap();
        let expected = "name: CI

# Runs on every push.
on:
  push:
  workflow_dispatch:

jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@REF
    with:
      os: linux

  test:
    needs: relay-test
    runs-on: ${{ needs.relay-test.outputs.runner }} # keep this comment
    steps:
      - uses: actions/checkout@v4
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint

  # Builds after both checks pass.
  relay-build:
    uses: relayrunner/actions/.github/workflows/relay.yml@REF
    with:
      os: linux

  build:
    needs: [test, lint, relay-build]
    runs-on: ${{ needs.relay-build.outputs.runner }}
    steps:
      - run: npm run build
"
        .replace("REF", relay_ref());
        assert_eq!(out, expected);
        let all = route_jobs(SOURCE, &jobs, false).unwrap();
        assert!(
            judge(&all, "macos", false)
                .iter()
                .all(|j| j.verdict == Verdict::Routed)
        );
    }

    #[test]
    fn exact_keeps_the_label() {
        let source = "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n  mac:\n    runs-on: macos-15\n    steps:\n      - run: npm test\n";
        let jobs = judge(source, "macos", false);
        let out = route_jobs(source, &jobs, true).unwrap();
        assert!(out.contains("      machine: self-hosted\n      github: ubuntu-latest\n"));
        assert!(out.contains("      machine: macOS\n      github: macos-15\n"));
        assert!(
            judge(&out, "macos", false)
                .iter()
                .all(|j| j.verdict == Verdict::Routed)
        );
    }

    #[test]
    fn shapes_from_labels() {
        let shape = |label: &str, provider: &str| {
            let s = shape_of(label, provider);
            (s.os, s.arch, s.cpus)
        };
        for (label, provider, want) in [
            ("ubuntu-latest", "github", ("linux", None, None)),
            ("ubuntu-24.04", "github", ("linux", None, None)),
            ("ubuntu-24.04-arm", "github", ("linux", Some("arm64"), None)),
            ("macos-15", "github", ("macos", None, None)),
            ("macos-latest-xlarge", "github", ("macos", None, None)),
            ("macos-13", "github", ("macos", Some("x64"), None)),
            ("macos-latest-large", "github", ("macos", Some("x64"), None)),
            ("macos-15-intel", "github", ("macos", Some("x64"), None)),
            (
                "blacksmith-2vcpu-ubuntu-2404",
                "blacksmith",
                ("linux", None, None),
            ),
            (
                "blacksmith-4vcpu-ubuntu-2404",
                "blacksmith",
                ("linux", None, Some(4)),
            ),
            (
                "blacksmith-8vcpu-ubuntu-2404-arm",
                "blacksmith",
                ("linux", Some("arm64"), Some(8)),
            ),
            ("depot-ubuntu-24.04", "depot", ("linux", None, None)),
            ("depot-ubuntu-24.04-8", "depot", ("linux", None, Some(8))),
            (
                "depot-ubuntu-24.04-arm-16",
                "depot",
                ("linux", Some("arm64"), Some(16)),
            ),
            ("depot-macos-latest", "depot", ("macos", None, None)),
            (
                "warp-ubuntu-latest-x64-4x",
                "warpbuild",
                ("linux", None, Some(4)),
            ),
            (
                "warp-ubuntu-latest-arm64-2x",
                "warpbuild",
                ("linux", Some("arm64"), None),
            ),
            ("ubicloud-standard-2", "ubicloud", ("linux", None, None)),
            (
                "ubicloud-standard-8-arm",
                "ubicloud",
                ("linux", Some("arm64"), Some(8)),
            ),
            (
                "nscloud-ubuntu-22.04-amd64-4x16",
                "namespace",
                ("linux", None, Some(4)),
            ),
            (
                "namespace-profile-default",
                "namespace",
                ("linux", None, None),
            ),
            (
                "starsling-ubuntu-24.04-4",
                "starsling",
                ("linux", None, Some(4)),
            ),
            ("groundbox-4vcpu", "groundbox", ("linux", None, Some(4))),
            ("boat-large", "boat", ("linux", None, None)),
            ("lizard-medium-ubuntu-2404", "lizard", ("linux", None, None)),
        ] {
            assert_eq!(shape(label, provider), want, "{label}");
        }
    }

    #[test]
    fn writes_the_shape() {
        let source = "on: push\njobs:\n  arm:\n    runs-on: ubuntu-24.04-arm\n    steps:\n      - run: npm test\n  mac:\n    runs-on: macos-13\n    steps:\n      - run: npm test\n  big:\n    runs-on: blacksmith-8vcpu-ubuntu-2404\n    steps:\n      - run: npm test\n";
        let jobs = judge(source, "macos", false);
        let out = route_jobs(source, &jobs, false).unwrap();
        assert!(out.contains("    with:\n      os: linux\n      arch: arm64\n\n  arm:"));
        assert!(out.contains("    with:\n      os: macos\n      arch: x64\n\n  mac:"));
        assert!(out.contains("    with:\n      os: linux\n      cpus: 8\n\n  big:"));
        assert!(!out.contains("machine:"));
        assert!(
            judge(&out, "macos", false)
                .iter()
                .all(|j| j.verdict == Verdict::Routed)
        );
    }

    #[test]
    fn needs_in_every_shape() {
        let input = "on: push
jobs:
  relay-test:
    runs-on: ubuntu-latest
  test:
    needs: build
    runs-on: blacksmith-4vcpu-ubuntu-2404
  build:
    runs-on: ubuntu-latest
";
        let test = judge(input, "macos", false)
            .into_iter()
            .find(|j| j.job == "test")
            .unwrap();
        let out = route_jobs(input, &[test], false).unwrap();
        assert!(out.contains("\n\n  relay-test-2:\n"));
        assert!(out.contains("      os: linux\n      cpus: 4\n"));
        assert!(out.contains("    needs: [build, relay-test-2]\n"));

        let block = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n  b:\n    needs:\n      - a\n    runs-on: ubuntu-latest\n";
        let b = judge(block, "linux", false).pop().unwrap();
        assert!(
            route_jobs(block, &[b], false)
                .unwrap()
                .contains("    needs:\n      - a\n      - relay-b\n")
        );
    }

    #[test]
    fn keeps_the_rest_byte_for_byte() {
        // Four-space indents, CRLF, quotes and no newline at the end.
        let source = "on: [push, pull_request]\r\njobs:\r\n    a:\r\n        runs-on: \"ubuntu-latest\"\r\n        steps:\r\n            - run: echo 'hi'   # say hi";
        let a = judge(source, "linux", false).remove(0);
        let out = route_jobs(source, &[a], false).unwrap();
        assert_eq!(
            out,
            format!(
                "on: [push, pull_request]\r\njobs:\r\n    relay-a:\r\n        uses: {}@{}\r\n        with:\r\n            os: linux\r\n\r\n    a:\r\n        needs: relay-a\r\n        runs-on: ${{{{ needs.relay-a.outputs.runner }}}}\r\n        steps:\r\n            - run: echo 'hi'   # say hi",
                relay_workflow(),
                relay_ref()
            )
        );
    }

    #[test]
    fn refuses_what_it_cant_edit() {
        let skipped = one(&job("    runs-on: windows-latest\n"));
        assert!(
            route_jobs(&job("    runs-on: windows-latest\n"), &[skipped], false)
                .unwrap_err()
                .contains("isn't ready")
        );
        let inline = "on: push\njobs: {a: {runs-on: ubuntu-latest}}\n";
        let a = judge(inline, "linux", false).remove(0);
        assert!(route_jobs(inline, &[a], false).is_err());
    }
}
