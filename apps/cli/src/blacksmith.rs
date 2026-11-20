//! `relayrunner blacksmith connect`: connect a Blacksmith organization so the dashboard shows its
//! real usage (Settings › Providers). Blacksmith has no usage API, so RelayRunner reads usage with
//! Blacksmith's own CLI and an org token. This command makes that token here, on the user's
//! computer: it runs `blacksmith org-token create`, which the user approves in their browser as a
//! Blacksmith org admin, and sends only the printed token to the gateway
//! (PUT /api/machines/me/providers/blacksmith/connection). It never signs in to Blacksmith itself,
//! and never reads or sends Blacksmith's own saved credentials.
//!
//! Blacksmith's CLI is used from PATH, or from ~/.relayrunner/bin, where this downloads it from
//! Blacksmith's release host after asking, checked against the SHA-256 that host publishes.

use crate::api::{self, Reply};
use crate::credentials::{self, Credentials};
use crate::error::Error;
use crate::ui;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const RELEASES: &str = "https://clireleases.blacksmith.sh/cli/latest";
// The org token's label in Blacksmith's list of tokens.
const TOKEN_LABEL: &str = "relayrunner";

#[derive(Debug, Default, PartialEq)]
pub struct Args {
    /// The RelayRunner workspace to connect it to: a name, slug or id.
    pub workspace: Option<String>,
    /// Download Blacksmith's CLI without asking.
    pub yes: bool,
}

impl Args {
    pub fn parse(rest: &[String]) -> Result<Args, Error> {
        let usage = || {
            Error::new(
                "USAGE",
                "Usage: relayrunner blacksmith connect [--workspace NAME] [--yes]",
            )
        };
        let mut args = Args::default();
        let mut rest = rest.iter();
        match rest.next().map(String::as_str) {
            Some("connect") => {}
            _ => return Err(usage()),
        }
        while let Some(arg) = rest.next() {
            match arg.as_str() {
                "--workspace" => args.workspace = Some(rest.next().ok_or_else(usage)?.clone()),
                "--yes" | "-y" => args.yes = true,
                other => match other.strip_prefix("--workspace=") {
                    Some(value) => args.workspace = Some(value.to_string()),
                    None => return Err(usage()),
                },
            }
        }
        Ok(args)
    }
}

/// What `org-token create` printed that this needs.
#[derive(Debug, Default, PartialEq)]
pub struct Minted {
    pub token: Option<String>,
    pub organization: Option<String>,
}

impl Minted {
    /// Reads one line of `org-token create`'s output. True when it's for the user to see: the
    /// token and the line telling an agent how to log in with it stay out of the terminal.
    pub fn read(&mut self, line: &str) -> bool {
        let line = line.trim();
        if is_token(line) {
            self.token = Some(line.to_string());
            return false;
        }
        if let Some(rest) = line.split("Org token minted for ").nth(1) {
            let org = rest
                .split(". ")
                .next()
                .unwrap_or(rest)
                .trim_end_matches('.');
            if !org.is_empty() {
                self.organization = Some(org.to_string());
            }
            return false;
        }
        !line.starts_with("Provide it to your agent")
    }

    /// The token's id, for `blacksmith org-token revoke <id>`.
    pub fn id(&self) -> Option<&str> {
        self.token.as_deref()?.split_once('|').map(|(id, _)| id)
    }
}

/// `<numeric id>|<secret>`, as Blacksmith prints an org token.
fn is_token(line: &str) -> bool {
    match line.split_once('|') {
        Some((id, secret)) => {
            !id.is_empty()
                && id.bytes().all(|b| b.is_ascii_digit())
                && secret.len() >= 8
                && !secret.contains(char::is_whitespace)
        }
        None => false,
    }
}

/// Blacksmith's names for this platform, as its release host has them.
fn platform() -> Option<(&'static str, &'static str)> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        _ => return None,
    };
    let arch = match std::env::consts::ARCH {
        "x86_64" => "amd64",
        "aarch64" => "arm64",
        _ => return None,
    };
    Some((os, arch))
}

fn on_path() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join("blacksmith"))
        .find(|file| is_executable(file))
}

fn is_executable(file: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(file).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn downloaded() -> PathBuf {
    credentials::home().join("bin").join("blacksmith")
}

/// Blacksmith's CLI: the one on PATH, the one this downloaded before, or a new download.
fn find_or_download(yes: bool) -> Result<PathBuf, Error> {
    if let Some(found) = on_path() {
        return Ok(found);
    }
    let target = downloaded();
    if is_executable(&target) {
        return Ok(target);
    }
    let (os, arch) = platform().ok_or_else(|| {
        Error::new(
            "UNSUPPORTED_MACHINE",
            "Blacksmith's CLI runs on macOS and Linux (x64 or arm64).",
        )
    })?;
    let url = format!("{RELEASES}/{os}/{arch}/blacksmith");
    if !yes {
        if !ui::can_ask() {
            return Err(Error::new(
                "BLACKSMITH_CLI_MISSING",
                "Blacksmith's CLI isn't installed. Install it (https://docs.blacksmith.sh/blacksmith-cli/overview), or run again with --yes to download it into ~/.relayrunner/bin.",
            ));
        }
        let question = format!(
            "Blacksmith's CLI isn't installed. Download it from {url} into {}?",
            target.display()
        );
        if ui::confirm(&question, true) != Some(true) {
            return Err(Error::new(
                "CANCELLED",
                "Install Blacksmith's CLI (https://docs.blacksmith.sh/blacksmith-cli/overview) and run this again.",
            ));
        }
    }
    ui::spinner("Downloading Blacksmith's CLI");
    let result = download(&url, &target);
    ui::stop_spinner(
        if result.is_ok() {
            "Downloaded Blacksmith's CLI"
        } else {
            "Couldn't download Blacksmith's CLI"
        },
        result.is_ok(),
    );
    result.map(|()| target)
}

fn download(url: &str, target: &Path) -> Result<(), Error> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    let failed = |reason: String| Error::new("BLACKSMITH_CLI_DOWNLOAD", reason);
    let io = |e: std::io::Error| failed(e.to_string());
    let agent = api::agent_with(std::time::Duration::from_secs(300), true);
    let expected = agent
        .get(&format!("{url}.sha256"))
        .call()
        .and_then(|mut r| r.body_mut().read_to_string())
        .map_err(|e| failed(format!("Couldn't read the CLI's checksum ({e}).")))?;
    let expected = expected
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(failed("Blacksmith's checksum file isn't a SHA-256.".into()));
    }
    let dir = target.parent().expect("a file in a directory");
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(io)?;
    let temp = dir.join(format!(".blacksmith-{}", std::process::id()));
    let result = (|| {
        let response = agent
            .get(url)
            .call()
            .map_err(|e| failed(format!("Download failed ({e}). Check network access.")))?;
        let mut reader = response.into_body().into_reader();
        let mut file = std::fs::File::create(&temp).map_err(io)?;
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
        if format!("{:x}", hash.finalize()) != expected {
            return Err(Error::new(
                "BLACKSMITH_CLI_CHECKSUM",
                "Blacksmith's CLI failed SHA-256 verification.",
            ));
        }
        std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o755)).map_err(io)?;
        std::fs::rename(&temp, target).map_err(io)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// Runs `blacksmith org-token create`, showing what it says except the token itself.
fn mint(blacksmith: &Path) -> Result<Minted, Error> {
    let failed = |reason: String| Error::new("BLACKSMITH_TOKEN_FAILED", reason);
    let mut child = Command::new(blacksmith)
        .args(["org-token", "create", "--label", TOKEN_LABEL])
        .env("BLACKSMITH_DISABLE_AUTO_UPDATE", "1")
        .stdin(Stdio::inherit())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| failed(format!("Couldn't run {} ({e}).", blacksmith.display())))?;
    let mut minted = Minted::default();
    if let Some(stdout) = child.stdout.take() {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if minted.read(&line) && !line.trim().is_empty() {
                ui::message(line.trim());
            }
        }
    }
    let status = child.wait().map_err(|e| failed(e.to_string()))?;
    if !status.success() || minted.token.is_none() {
        return Err(failed(
            "Blacksmith didn't create an org token. Only an admin of the Blacksmith organization can create one.".into(),
        ));
    }
    Ok(minted)
}

enum Sent {
    Connected(Value),
    /// More than one workspace could take it, or none matched the organization.
    Unclear(Vec<Value>),
    Failed(Error),
}

fn send(credentials: &Credentials, minted: &Minted, workspace: Option<&str>) -> Sent {
    let server = &credentials.server;
    let mut options = serde_json::Map::new();
    if let Some(org) = &minted.organization {
        options.insert("organization".into(), json!(org));
    }
    let mut body = json!({ "token": minted.token, "options": options });
    if let Some(workspace) = workspace {
        body["workspace"] = json!(workspace);
    }
    let failed = |reason: String| {
        Sent::Failed(Error::new(
            "BLACKSMITH_CONNECT_FAILED",
            format!("Couldn't connect Blacksmith: {reason}."),
        ))
    };
    match api::call_as_machine(
        credentials,
        "PUT",
        "/api/machines/me/providers/blacksmith/connection",
        Some(&body),
    ) {
        Reply::Ok(body) if body["connection"].is_object() => Sent::Connected(body),
        Reply::Ok(_) => failed(format!("{server} sent an unexpected response")),
        Reply::Revoked => Sent::Failed(crate::share::revoked(&credentials.machine.name)),
        Reply::Status(409, body) if body["error"]["code"] == "PROVIDER_WORKSPACE_UNCLEAR" => {
            Sent::Unclear(
                body["error"]["details"]["workspaces"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
            )
        }
        Reply::Status(404, _) if workspace.is_some() => {
            failed("that isn't a workspace you own or administer".into())
        }
        Reply::Status(404 | 405, _) => failed(format!(
            "{server} doesn't support connecting Blacksmith yet"
        )),
        Reply::Status(status, body) => {
            let reason = body["error"]["details"]["reason"]
                .as_str()
                .map(|r| format!(" ({r})"))
                .unwrap_or_default();
            failed(format!(
                "{}{reason}",
                api::failure_reason(server, status, &body)
            ))
        }
        Reply::Unreachable(reason) => failed(reason),
    }
}

/// Asks which workspace to connect it to, by id. None when nobody can answer.
fn pick(workspaces: &[Value]) -> Option<String> {
    if !ui::can_ask() || workspaces.is_empty() {
        return None;
    }
    let choices: Vec<ui::Choice> = workspaces
        .iter()
        .map(|w| ui::Choice {
            label: w["name"].as_str().unwrap_or("?").to_string(),
            hint: w["slug"].as_str().map(str::to_string),
        })
        .collect();
    let index = ui::select(
        "Which workspace should show its Blacksmith usage?",
        &choices,
        0,
    )?;
    workspaces[index]["id"].as_str().map(str::to_string)
}

pub fn command(credentials: &Credentials, rest: &[String]) -> Result<(), Error> {
    let args = Args::parse(rest)?;
    ui::intro("Connect Blacksmith");
    let blacksmith = find_or_download(args.yes)?;
    ui::step("Approve the org token in your browser. Blacksmith asks you to sign in first.");
    let minted = mint(&blacksmith)?;
    // The token is only ever shown once, so a connection that fails leaves it unused.
    let unused = |error: Error| match minted.id() {
        Some(id) => Error::new(
            error.code,
            format!(
                "{}\nThe new org token isn't used anywhere. Remove it with `blacksmith org-token revoke {id}`.",
                error.message
            ),
        ),
        None => error,
    };
    let mut workspace = args.workspace.clone();
    let connected = loop {
        match send(credentials, &minted, workspace.as_deref()) {
            Sent::Connected(body) => break body,
            Sent::Failed(error) => return Err(unused(error)),
            Sent::Unclear(workspaces) => match pick(&workspaces) {
                Some(id) if workspace.is_none() => workspace = Some(id),
                _ => {
                    let slugs: Vec<&str> = workspaces
                        .iter()
                        .filter_map(|w| w["slug"].as_str())
                        .collect();
                    return Err(unused(Error::new(
                        "BLACKSMITH_CONNECT_FAILED",
                        format!(
                            "Couldn't tell which workspace to connect Blacksmith to. Run again with --workspace and one of: {}.",
                            slugs.join(", ")
                        ),
                    )));
                }
            },
        }
    };
    let organization = connected["connection"]["options"]["organization"]
        .as_str()
        .or(minted.organization.as_deref())
        .unwrap_or("Blacksmith");
    let name = connected["workspace"]["name"]
        .as_str()
        .unwrap_or("your workspace");
    ui::success(&format!(
        "Connected {organization} on Blacksmith to {name}. Its usage shows in Settings › Providers within the hour."
    ));
    ui::outro(
        "Remove it there any time, then revoke the token with `blacksmith org-token revoke`.",
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn parses_connect_and_its_flags() {
        assert_eq!(
            Args::parse(&strings(&["connect"])).unwrap(),
            Args::default()
        );
        assert_eq!(
            Args::parse(&strings(&["connect", "--workspace", "acme", "--yes"])).unwrap(),
            Args {
                workspace: Some("acme".into()),
                yes: true
            }
        );
        assert_eq!(
            Args::parse(&strings(&["connect", "--workspace=acme"]))
                .unwrap()
                .workspace
                .as_deref(),
            Some("acme")
        );
        assert!(Args::parse(&strings(&[])).is_err());
        assert!(Args::parse(&strings(&["disconnect"])).is_err());
        assert!(Args::parse(&strings(&["connect", "--workspace"])).is_err());
        assert!(Args::parse(&strings(&["connect", "--nope"])).is_err());
    }

    #[test]
    fn reads_the_token_and_org_and_hides_the_token() {
        // What `blacksmith org-token create` printed for a real organization (token made up).
        let output = [
            "Opening browser to authenticate...",
            "Waiting for authentication...",
            "Org token minted for relayrunner. It will not be shown again.",
            "Provide it to your agent with: blacksmith auth login --api-token - --non-interactive --organization relayrunner",
            "3760036089|1sQAf5abcdefghijklmnop",
        ];
        let mut minted = Minted::default();
        let shown: Vec<&str> = output
            .into_iter()
            .filter(|line| minted.read(line))
            .collect();
        assert_eq!(
            shown,
            [
                "Opening browser to authenticate...",
                "Waiting for authentication..."
            ]
        );
        assert_eq!(minted.organization.as_deref(), Some("relayrunner"));
        assert_eq!(
            minted.token.as_deref(),
            Some("3760036089|1sQAf5abcdefghijklmnop")
        );
        assert_eq!(minted.id(), Some("3760036089"));
    }

    #[test]
    fn a_token_is_a_numeric_id_and_a_secret() {
        assert!(is_token("12|abcdefgh"));
        assert!(!is_token("12|short"));
        assert!(!is_token("ab|abcdefgh"));
        assert!(!is_token("|abcdefgh"));
        assert!(!is_token("12|abc defgh"));
        assert!(!is_token("Waiting for authentication..."));
    }
}
