// Downloads GitHub's actions/runner once per version and verifies its SHA-256 before unpacking.
// Ported from the old CLI's install() (b475b62), minus its `gh` dependency: the release and its
// checksums come from GitHub's public releases API.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { runnersDir, userAgent } from "./paths.ts";

export class RunnerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface InstalledRunner {
  version: string;
  dir: string;
}

// The runner's own names: actions-runner-<os>-<arch>-<version>.tar.gz.
export type RunnerPlatform = { os: "osx" | "linux"; arch: "x64" | "arm64" };

export interface RunnerDownload {
  version: string;
  url: string;
  sha256: string;
}

const LATEST_RELEASE = "https://api.github.com/repos/actions/runner/releases/latest";
const ARCHIVE_URL =
  /^https:\/\/github\.com\/actions\/runner\/releases\/download\/v[\d.]+\/actions-runner-[\w.-]+\.tar\.gz$/;
const SHA256 = /^[a-f\d]{64}$/;

const Release = z.object({
  tag_name: z.string().regex(/^v\d+\.\d+\.\d+$/),
  body: z.string().nullish(),
  assets: z.array(
    z.object({
      name: z.string(),
      browser_download_url: z.string(),
      // "sha256:<hex>", on releases published since GitHub started recording digests.
      digest: z.string().nullish(),
    }),
  ),
});

export function runnerPlatform(): RunnerPlatform {
  const system = platform();
  const os = system === "darwin" ? "osx" : system;
  const architecture = arch();
  if (
    (os !== "osx" && os !== "linux") ||
    (architecture !== "x64" && architecture !== "arm64") ||
    process.getuid?.() === 0
  ) {
    throw new RunnerError(
      "UNSUPPORTED_MACHINE",
      "Run as a regular user on macOS or Linux (x64 or arm64).",
    );
  }
  return { os, arch: architecture };
}

// Picks this platform's archive out of a release and its checksum. The checksum comes from the
// asset's digest, or the `<!-- BEGIN SHA osx-arm64 -->` markers GitHub's runner team puts in the
// release notes. If both are there they must agree.
export function pickDownload(release: unknown, target: RunnerPlatform): RunnerDownload {
  const parsed = Release.safeParse(release);
  if (!parsed.success)
    throw new RunnerError("RUNNER_DOWNLOAD", "GitHub returned an unexpected runner release.");
  const { tag_name, body, assets } = parsed.data;
  const version = tag_name.slice(1);
  const name = `actions-runner-${target.os}-${target.arch}-${version}.tar.gz`;
  const asset = assets.find((item) => item.name === name);

  const key = `${target.os}-${target.arch}`;
  const fromNotes = body
    ?.match(
      new RegExp(`<!-- BEGIN SHA ${key} -->\\s*([a-fA-F\\d]{64})\\s*<!-- END SHA ${key} -->`),
    )?.[1]
    ?.toLowerCase();
  const fromDigest = asset?.digest?.match(/^sha256:([a-fA-F\d]{64})$/)?.[1]?.toLowerCase();
  const sha256 = fromDigest ?? fromNotes;

  if (
    !asset ||
    !ARCHIVE_URL.test(asset.browser_download_url) ||
    !sha256 ||
    !SHA256.test(sha256) ||
    (fromDigest && fromNotes && fromDigest !== fromNotes)
  ) {
    throw new RunnerError(
      "RUNNER_DOWNLOAD",
      `GitHub did not provide a ${name} archive with a SHA-256 checksum.`,
    );
  }
  return { version, url: asset.browser_download_url, sha256 };
}

async function latestRelease(): Promise<unknown> {
  const response = await fetch(LATEST_RELEASE, {
    headers: { accept: "application/vnd.github+json", "user-agent": userAgent },
  });
  if (!response.ok)
    throw new RunnerError(
      "RUNNER_DOWNLOAD",
      `Could not look up the latest actions/runner release (HTTP ${response.status}).`,
    );
  return response.json();
}

// The latest actions/runner version, which is also the tag of GitHub's runner image for it. If
// GitHub can't be reached, the newest version installed here.
export async function latestRunnerVersion(log: (line: string) => void = () => {}) {
  try {
    return Release.parse(await latestRelease()).tag_name.slice(1);
  } catch (error) {
    const [newest] = installedRunners();
    if (!newest) throw error;
    log(
      `Couldn't check for a newer runner (${(error as Error).message}). Using ${newest.version}.`,
    );
    return newest.version;
  }
}

// Installed versions, newest first.
export function installedRunners(root = runnersDir()): InstalledRunner[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => /^\d+\.\d+\.\d+$/.test(name) && existsSync(join(root, name, "run.sh")))
    .sort((a, b) => compareVersions(b, a))
    .map((version) => ({ version, dir: join(root, version) }));
}

function compareVersions(a: string, b: string) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The latest runner, downloading it if it isn't installed yet. If GitHub can't be reached, falls
// back to the newest installed version so a machine keeps working offline from github.com's API.
export async function ensureRunner(
  options: { root?: string; log?: (line: string) => void } = {},
): Promise<InstalledRunner> {
  const root = options.root ?? runnersDir();
  const log = options.log ?? (() => {});
  const target = runnerPlatform();

  let download: RunnerDownload;
  try {
    download = pickDownload(await latestRelease(), target);
  } catch (error) {
    const [newest] = installedRunners(root);
    if (newest) {
      log(
        `Couldn't check for a newer runner (${(error as Error).message}). Using ${newest.version}.`,
      );
      return newest;
    }
    throw error;
  }

  const dir = join(root, download.version);
  if (existsSync(join(dir, "run.sh"))) return { version: download.version, dir };

  log(`Downloading GitHub's official runner (actions/runner ${download.version})…`);
  await install(root, download);
  log(`Installed actions/runner ${download.version} in ${dir}`);
  return { version: download.version, dir };
}

export async function install(root: string, download: RunnerDownload, fetcher = fetch) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const temp = mkdtempSync(join(root, ".install-"));
  try {
    const archive = join(temp, "runner.tar.gz");
    const response = await fetcher(download.url, {
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok || !response.body)
      throw new RunnerError(
        "RUNNER_DOWNLOAD",
        `Runner download failed (HTTP ${response.status}). Check network access.`,
      );
    const hash = createHash("sha256");
    await pipeline(
      Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
      new Transform({
        transform(chunk, _encoding, done) {
          hash.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(archive, { mode: 0o600 }),
    );
    if (hash.digest("hex") !== download.sha256)
      throw new RunnerError("RUNNER_CHECKSUM", "The runner archive failed SHA-256 verification.");

    const unpacked = join(temp, "runner");
    mkdirSync(unpacked, { mode: 0o700 });
    if ((await exitCode("tar", ["-xzf", archive, "-C", unpacked])) !== 0)
      throw new RunnerError(
        "RUNNER_EXTRACT",
        "Could not unpack the runner archive. Check tar and available disk space.",
      );
    try {
      renameSync(unpacked, join(root, download.version));
    } catch (error) {
      // Another `relayrunner` installed the same version first. Theirs is just as good.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
    }
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

// The command's exit code, or null when it couldn't start (not installed).
function exitCode(command: string, args: string[]) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code));
  });
}
