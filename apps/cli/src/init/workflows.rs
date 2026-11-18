//! What `relayrunner init` knows about a repo's workflows: which jobs can route through the relay,
//! which already do, and which it leaves alone and why. Then the edit itself,
//! which works on the file's lines, so everything it doesn't add or change stays byte for byte,
//! and it checks that the result reads back routed.
//!
//! A routed job gets a relay job in front of it, the reusable workflow in relayrunner/actions,
//! and runs wherever the relay answers:
//!
//!   relay-test:
//!     uses: relayrunner/actions/.github/workflows/relay.yml@<RELAY_REF>
//!     with:
//!       machine: self-hosted
//!       github: ubuntu-latest
//!   test:
//!     needs: relay-test
//!     runs-on: ${{ needs.relay-test.outputs.runner }}

use serde::Serialize;
use yaml_rust2::{Yaml, YamlLoader, yaml::Hash};

/// The relay version `init` writes. Bump it with each relayrunner/actions release, along with the
/// skills and agent guide that show it (a test checks them).
pub const RELAY_REF: &str = "v1.0.0-beta.7";
pub const RELAY_WORKFLOW: &str = "relayrunner/actions/.github/workflows/relay.yml";

/// The hosted providers a relay can send a job to, and how their labels start: a copy of
/// LABEL_PREFIXES in @relayrunner/providers. A prefix ending in `-` also matches the bare name.
const HOSTED_PROVIDERS: &[(&str, &[&str])] = &[
    ("blacksmith", &["blacksmith-"]),
    ("depot", &["depot-"]),
    ("namespace", &["namespace-profile-", "nscloud-"]),
    ("warpbuild", &["warp-"]),
    ("ubicloud", &["ubicloud-"]),
    ("boat", &["boat-", "boat/"]),
    ("runs-on", &["runs-on=", "runs-on/"]),
    ("starsling", &["starsling-"]),
    ("monkci", &["monkci-"]),
    ("runloft", &["runloft-"]),
    ("latchkey", &["latchkey-"]),
    ("berrybox", &["berrybox-"]),
    ("celesto", &["celesto-"]),
    ("instabox", &["instabox-"]),
];

fn hosted_provider_of(lower: &str) -> Option<&'static str> {
    HOSTED_PROVIDERS.iter().find_map(|(id, prefixes)| {
        prefixes
            .iter()
            .any(|p| lower.starts_with(p) || p.strip_suffix('-') == Some(lower))
            .then_some(*id)
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
    /// For a ready job: the relay's `machine` input.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub machine: Option<&'static str>,
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
        Some(_) => return skip("runs-on is a list of labels or a runner group"),
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
    if let Some(deploy) = deploy_signal(job, workflow) {
        return skip(&format!("looks like a deploy job ({deploy})"));
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

    WorkflowJob {
        verdict: Verdict::Ready,
        warnings: job_warnings(job, options),
        provider: Some(provider),
        label: Some(label.to_string()),
        machine: Some(machine),
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
    matches!(get(job, "uses"), Some(Yaml::String(uses)) if uses.split('@').next() == Some(RELAY_WORKFLOW))
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

fn deploy_signal(job: &Hash, workflow: &Hash) -> Option<String> {
    if get(job, "environment").is_some() {
        return Some("environment".into());
    }
    let permissions = match get(job, "permissions") {
        None | Some(Yaml::Null) => get(workflow, "permissions"),
        set => set,
    };
    match permissions {
        Some(Yaml::String(s)) if s == "write-all" => return Some("write-all permissions".into()),
        Some(Yaml::Hash(p)) if matches!(get(p, "id-token"), Some(Yaml::String(s)) if s == "write") =>
        {
            return Some("id-token: write".into());
        }
        _ => {}
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
fn installs_linux_packages(script: &str) -> bool {
    let bytes = script.as_bytes();
    let starts_command = |i: usize| {
        i == 0
            || matches!(
                bytes[i - 1],
                b' ' | b'\t' | b'\n' | b'\r' | b';' | b'&' | b'|' | b'('
            )
    };
    (0..bytes.len()).filter(|&i| starts_command(i)).any(|i| {
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

/// Routes the given jobs of one workflow file through the relay, and returns the new contents.
/// Each job must have come back ready from `analyze` for this same source. Fails, with why, on a
/// layout it can't edit safely, such as jobs written inline.
pub fn route_jobs(source: &str, jobs: &[WorkflowJob]) -> Result<String, String> {
    let mut text = source.to_string();
    for job in jobs {
        let (Verdict::Ready, Some(provider), Some(label)) = (job.verdict, job.provider, &job.label)
        else {
            return Err(format!("{} isn't ready to route.", job.job));
        };
        text = route_job(
            &text,
            &job.job,
            provider,
            label,
            job.machine.unwrap_or("self-hosted"),
        )?;
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

fn route_job(
    source: &str,
    id: &str,
    provider: &str,
    label: &str,
    machine: &str,
) -> Result<String, String> {
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
    let block = [
        format!("{}{relay}:{eol}", pad(ji)),
        format!("{}uses: {RELAY_WORKFLOW}@{RELAY_REF}{eol}", pad(ji + step)),
        format!("{}with:{eol}", pad(ji + step)),
        format!(
            "{}machine: {}{eol}",
            pad(ji + 2 * step),
            yaml_scalar(machine)
        ),
        format!(
            "{}{provider}: {}{eol}",
            pad(ji + 2 * step),
            yaml_scalar(label)
        ),
        eol.to_string(),
    ];
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

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = ".github/workflows/ci.yml";

    fn judge(source: &str, host_os: &'static str, vm: bool) -> Vec<WorkflowJob> {
        let (jobs, errors) = analyze(
            &[WorkflowFile {
                file: FILE.into(),
                source: source.into(),
            }],
            &Options {
                host_os: Some(host_os),
                vm,
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

    /// The agent skills (skills/, installed with `npx skills add relayrunner/relayrunner`) and the
    /// agent guide show the relay version for hand-routed jobs. Keep it the one init writes.
    #[test]
    fn skills_show_the_relay_version_init_writes() {
        fn markdown(dir: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    markdown(&path, files);
                } else if path.extension().is_some_and(|ext| ext == "md") {
                    files.push(path);
                }
            }
        }
        let repo = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut files = vec![repo.join("docs/agent-install.md")];
        markdown(&repo.join("skills"), &mut files);
        for path in files {
            let text = std::fs::read_to_string(&path).unwrap();
            for marker in ["relay.yml@", "\"relay\": \""] {
                for (at, _) in text.match_indices(marker) {
                    let rest = &text[at + marker.len()..];
                    let end = rest
                        .find(|c: char| !(c.is_alphanumeric() || "._-".contains(c)))
                        .unwrap_or(rest.len());
                    let version = &rest[..end];
                    if version.starts_with('v') {
                        assert_eq!(version, RELAY_REF, "{}", path.display());
                    }
                }
            }
        }
    }

    /// The hosted providers match @relayrunner/providers.
    #[test]
    fn knows_the_same_providers_as_the_providers_package() {
        let providers = include_str!("../../../../packages/providers/src/index.ts");
        let table = providers
            .split_once("LABEL_PREFIXES")
            .and_then(|(_, rest)| rest.split_once("};"))
            .map(|(table, _)| table)
            .unwrap();
        assert_eq!(
            table.lines().filter(|l| l.contains(": [")).count(),
            HOSTED_PROVIDERS.len()
        );
        for (id, prefixes) in HOSTED_PROVIDERS {
            let quoted: Vec<String> = prefixes.iter().map(|p| format!("\"{p}\"")).collect();
            let line = format!("{id}: [{}],", quoted.join(", "));
            let quoted_id = format!("\"{id}\": [{}],", quoted.join(", "));
            assert!(
                providers.contains(&line) || providers.contains(&quoted_id),
                "{id}"
            );
        }
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
                "    runs-on: ubuntu-latest\n    permissions:\n      id-token: write\n",
                "deploy job (id-token: write)",
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
            "on: push\npermissions:\n  id-token: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n",
        );
        assert!(workflow_level.reason.unwrap().contains("id-token"));
        let reusable = one("on: workflow_call\njobs:\n  test:\n    runs-on: ubuntu-latest\n");
        assert!(reusable.reason.unwrap().contains("reusable workflow"));
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
        let out = route_jobs(SOURCE, &[jobs[0].clone(), jobs[2].clone()]).unwrap();
        let expected = "name: CI

# Runs on every push.
on:
  push:
  workflow_dispatch:

jobs:
  relay-test:
    uses: relayrunner/actions/.github/workflows/relay.yml@REF
    with:
      machine: self-hosted
      github: ubuntu-latest

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
      machine: self-hosted
      github: ubuntu-24.04

  build:
    needs: [test, lint, relay-build]
    runs-on: ${{ needs.relay-build.outputs.runner }}
    steps:
      - run: npm run build
"
        .replace("REF", RELAY_REF);
        assert_eq!(out, expected);
        let all = route_jobs(SOURCE, &jobs).unwrap();
        assert!(
            judge(&all, "macos", false)
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
        let out = route_jobs(input, &[test]).unwrap();
        assert!(out.contains("\n\n  relay-test-2:\n"));
        assert!(out.contains("      blacksmith: blacksmith-4vcpu-ubuntu-2404\n"));
        assert!(out.contains("    needs: [build, relay-test-2]\n"));

        let block = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n  b:\n    needs:\n      - a\n    runs-on: ubuntu-latest\n";
        let b = judge(block, "linux", false).pop().unwrap();
        assert!(
            route_jobs(block, &[b])
                .unwrap()
                .contains("    needs:\n      - a\n      - relay-b\n")
        );
    }

    #[test]
    fn keeps_the_rest_byte_for_byte() {
        // Four-space indents, CRLF, quotes and no newline at the end.
        let source = "on: [push, pull_request]\r\njobs:\r\n    a:\r\n        runs-on: \"ubuntu-latest\"\r\n        steps:\r\n            - run: echo 'hi'   # say hi";
        let a = judge(source, "linux", false).remove(0);
        let out = route_jobs(source, &[a]).unwrap();
        assert_eq!(
            out,
            format!(
                "on: [push, pull_request]\r\njobs:\r\n    relay-a:\r\n        uses: {RELAY_WORKFLOW}@{RELAY_REF}\r\n        with:\r\n            machine: self-hosted\r\n            github: ubuntu-latest\r\n\r\n    a:\r\n        needs: relay-a\r\n        runs-on: ${{{{ needs.relay-a.outputs.runner }}}}\r\n        steps:\r\n            - run: echo 'hi'   # say hi"
            )
        );
    }

    #[test]
    fn refuses_what_it_cant_edit() {
        let skipped = one(&job("    runs-on: windows-latest\n"));
        assert!(
            route_jobs(&job("    runs-on: windows-latest\n"), &[skipped])
                .unwrap_err()
                .contains("isn't ready")
        );
        let inline = "on: push\njobs: {a: {runs-on: ubuntu-latest}}\n";
        let a = judge(inline, "linux", false).remove(0);
        assert!(route_jobs(inline, &[a]).is_err());
    }
}
