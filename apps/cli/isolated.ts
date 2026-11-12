// `connect --isolated`: each job runs in its own Linux VM instead of on this machine, using
// Apple's `container` tool (https://github.com/apple/container). The VM starts from GitHub's
// runner image with nothing of the Mac mounted, takes one job and is deleted, so a job can't read
// the user's files, the machine token, or anything an earlier job left behind. Docker works inside
// the VM. Unless `--local-network` is given, a firewall inside the VM keeps the job off the local
// network: it reaches the internet, not the Mac or the LAN.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { arch, availableParallelism, homedir, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { latestRunnerVersion, RunnerError } from "./install.ts";
import { runnerEnv, type Launcher } from "./job.ts";
import { readList, writeList } from "./list-file.ts";
import { relayrunnerHome } from "./paths.ts";
import { cliVersion } from "./version.ts";

export interface Isolation {
  // The `container` binary. Tests point it at a stand-in.
  command: string;
  // The image each job's VM starts from: the runner image plus the start script (jobImage).
  image: string;
  // No firewall: jobs can reach this Mac and the local network.
  localNetwork: boolean;
  // Where each `container` call and its result go, for troubleshooting.
  debug: DebugLog;
  // The actions/runner version in that image, when it's GitHub's own.
  runnerVersion: string;
  // Each VM's share of this machine.
  cpus: number;
  memoryGb: number;
}

// GitHub's runner image, tagged by actions/runner version. It runs as `runner` in /home/runner.
const RUNNER_IMAGE = "ghcr.io/actions/actions-runner";
const RELEASES = "https://github.com/apple/container/releases";

// Why `--isolated` can't work on this machine, or null when it can. Apple's container tool needs
// Apple silicon and macOS 26, which is Darwin 25.
export function unsupportedReason(system = platform(), chip = arch(), darwin = release()) {
  if (system !== "darwin")
    return "--isolated needs a Mac with Apple silicon and macOS 26 or later.";
  if (chip !== "arm64")
    return "--isolated needs a Mac with Apple silicon. This one has an Intel chip.";
  if (Number.parseInt(darwin, 10) < 25)
    return "--isolated needs macOS 26 or later. Update macOS, then try again.";
  return null;
}

// Whether this Mac could run `--isolated` right now: it's supported and Apple's container tool is
// installed. `connect` suggests the flag then.
export async function isolationAvailable(command = "container", reason = unsupportedReason()) {
  return reason === null && (await call(command, ["--version"], NO_LOG, true)) === 0;
}

export interface DebugLog {
  path: string;
  write: (text: string) => void;
}

// A file that records what `--isolated` did, to share when something goes wrong. It starts over
// with each `connect`. It never holds a job's output or its JIT config.
export function debugLog(path = join(relayrunnerHome(), "isolated.log")): DebugLog {
  const home = homedir();
  const write = (text: string, flag: "a" | "w" = "a") => {
    try {
      // The home folder becomes `~`, so a shared log doesn't carry the user's name.
      const stamped = `${new Date().toISOString()} ${text.trimEnd().replaceAll(home, "~")}\n`;
      if (flag === "w") {
        rmSync(path, { force: true });
        writeFileSync(path, stamped, { mode: 0o600 });
      } else appendFileSync(path, stamped);
    } catch {
      // Best effort: a log that can't be written never stops a job.
    }
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {}
  write(
    `relayrunner ${cliVersion}, ${platform()} ${release()} ${arch()}, ${availableParallelism()} cores, ${Math.round(totalmem() / 1024 ** 3)} GB`,
    "w",
  );
  return { path, write };
}

export const NO_LOG: DebugLog = { path: "", write: () => {} };

// What the VM runs, as root with every capability, before the runner. Unless
// RELAYRUNNER_LOCAL_NETWORK is 1 it loads a firewall that lets the job reach the internet and DNS
// but not private addresses (the Mac, the LAN, link-local) or any IPv6 address. The same rules
// cover what Docker containers send out, and leave Docker's own networks alone. It then starts
// Docker, when the image has it, and the runner as `runner`. With the firewall the runner loses
// NET_ADMIN and NET_RAW for good, so `sudo` in a job step can't take the firewall down or send raw
// packets underneath it. Docker still runs as root: a job that starts a privileged container can
// remove the firewall, so it stops accidents, not a job that sets out to get past it.
export const START_SCRIPT = `#!/bin/sh
set -eu
drop=""
if [ "\${RELAYRUNNER_LOCAL_NETWORK:-}" != 1 ]; then
  drop="--bounding-set -net_admin,-net_raw"
  dns=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
  allow_dns=""
  [ -z "$dns" ] || allow_dns="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"
  nft -f - <<EOF
table inet relayrunner {
  chain private {
    oifname { "lo", "docker0" } accept
    oifname "br-*" accept
    $allow_dns
    ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    meta nfproto ipv6 drop
  }
  chain out {
    type filter hook output priority 0; policy accept;
    jump private
  }
  chain forward {
    type filter hook forward priority 0; policy accept;
    jump private
  }
}
EOF
fi
# Docker sets kernel network settings under /proc/sys, which starts read-only. A job without
# Docker loses nothing if it can't start, so failures here only reach the Docker log.
if command -v dockerd >/dev/null 2>&1; then
  mount -o remount,rw /proc/sys 2>/dev/null || true
  dockerd >/var/log/dockerd.log 2>&1 &
  tries=0
  until docker info >/dev/null 2>&1 || [ "$tries" -ge 50 ]; do
    tries=$((tries + 1))
    sleep 0.2
  done
fi
cd /home/runner
# With arguments, runs them in place of the runner, to check the VM by hand.
[ $# -gt 0 ] || set -- ./run.sh --jitconfig "$RUNNER_JIT_CONFIG"
exec setpriv --reuid runner --regid runner --init-groups $drop \\
  env HOME=/home/runner USER=runner LOGNAME=runner "$@"
`;

const START_PATH = "/usr/local/bin/relayrunner-start";

// The job image: a runner image with the start script, nftables for its firewall and iptables
// for Docker's networks.
export function dockerfile(base: string) {
  return `FROM ${base}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iptables nftables && apt-get clean
COPY --chmod=755 start.sh ${START_PATH}
`;
}

// The job image's local tag. It changes with the base image, the Dockerfile or the start script,
// so a new runner version or CLI builds a new image.
export function jobImage(base: string) {
  const hash = createHash("sha256").update(dockerfile(base)).update(START_SCRIPT).digest("hex");
  return `relayrunner-runner:${hash.slice(0, 12)}`;
}

// An even split of the cores between slots, and of half the memory, so the Mac stays usable
// while every slot is busy. At least 2 CPUs and 2 GB each; at most 16 GB.
export function vmSize(slots: number, cores = availableParallelism(), memoryBytes = totalmem()) {
  const gb = memoryBytes / 1024 ** 3;
  return {
    cpus: Math.max(2, Math.floor(cores / slots)),
    memoryGb: Math.min(16, Math.max(2, Math.floor(gb / 2 / slots))),
  };
}

// Checks Apple's container tool is running and gets the job image ready, so the first job
// doesn't wait for it. Throws a RunnerError that says what to do otherwise.
export async function prepareIsolation(options: {
  slots: number;
  // Another runner image to start from. It needs a `runner` user in /home/runner, and apt.
  image?: string;
  localNetwork?: boolean;
  command?: string;
  log?: (line: string) => void;
  debug?: DebugLog;
  // The record of images earlier runs downloaded or built (managedImagesFile).
  managed?: string;
}): Promise<Isolation> {
  const command = options.command ?? "container";
  const log = options.log ?? (() => {});
  const debug = options.debug ?? NO_LOG;
  const localNetwork = options.localNetwork ?? false;
  const tool = (args: string[]) => call(command, args, debug);
  const hasImage = async (image: string) =>
    (await call(command, ["image", "inspect", image], debug, true)) === 0;
  const fail = (code: string, message: string) =>
    new RunnerError(code, debug.path ? `${message} Details are in ${debug.path}.` : message);

  // The lookup's failure waits until the container tool has been checked.
  const latest = latestRunnerVersion(log);
  latest.catch(() => {});
  const [status] = await Promise.all([tool(["system", "status"]), tool(["--version"])]);
  if (status === null)
    throw new RunnerError(
      "ISOLATED_SETUP",
      `--isolated needs Apple's container tool. Install it from ${RELEASES}, then run \`container system start\`.`,
    );
  if (status !== 0)
    throw fail(
      "ISOLATED_SETUP",
      "Apple's container tool isn't running. Run `container system start`, then try again.",
    );

  const runnerVersion = await latest;
  const base = options.image ?? `${RUNNER_IMAGE}:${runnerVersion}`;
  // Images this run needs, and of those the ones it may delete later: what it builds, and
  // GitHub's runner image when it's the one to download it. Never an image given with --image.
  const mine: string[] = [];
  if (!(await hasImage(base))) {
    log(`Downloading ${base}. This happens once per runner version…`);
    if ((await tool(["image", "pull", base])) !== 0)
      throw fail("ISOLATED_IMAGE", `Could not download ${base}.`);
    if (!options.image) mine.push(base);
  }
  const image = jobImage(base);
  mine.push(image);
  if (!(await hasImage(image))) {
    log(`Building the job image from ${base}. This happens once per runner version…`);
    const context = mkdtempSync(join(tmpdir(), "relayrunner-image-"));
    try {
      writeFileSync(join(context, "Dockerfile"), dockerfile(base));
      writeFileSync(join(context, "start.sh"), START_SCRIPT);
      if ((await tool(["build", "--progress", "plain", "--tag", image, context])) !== 0)
        throw fail("ISOLATED_IMAGE", `Could not build the job image from ${base}.`);
    } finally {
      rmSync(context, { recursive: true, force: true });
      // The build leaves Apple's builder VM behind. It comes back by itself when needed.
      await tool(["builder", "stop"]);
      await tool(["builder", "delete"]);
    }
  }
  await pruneImages(options.managed ?? managedImagesFile(), [base, image], mine, tool, log);
  const size = vmSize(options.slots);
  log(
    `Each job runs in its own Linux VM with ${size.cpus} CPUs and ${size.memoryGb} GB of memory.`,
  );
  if (localNetwork) log("Jobs can reach this Mac and your local network.");
  if (debug.path) log(`If something goes wrong, ${debug.path} has the details.`);
  return { command, image, localNetwork, debug, runnerVersion, ...size };
}

export function managedImagesFile() {
  return join(relayrunnerHome(), "isolated-images.json");
}

// Deletes the images earlier runs downloaded or built that this one doesn't use, so each new
// runner version doesn't leave a gigabyte or two behind. Images the user got themselves are
// never in the record, so they're never touched.
async function pruneImages(
  file: string,
  inUse: string[],
  mine: string[],
  tool: (args: string[]) => Promise<number | null>,
  log: (line: string) => void,
) {
  const recorded = readList(file);
  for (const image of recorded) {
    if (inUse.includes(image)) continue;
    if ((await tool(["image", "delete", image])) === 0) log(`Removed the old image ${image}.`);
  }
  try {
    writeList(
      file,
      inUse.filter((image) => recorded.includes(image) || mine.includes(image)),
    );
  } catch {
    // Best effort: without the record, old images stay until deleted by hand.
  }
}

// The VM's name, which is also how a job that's still running is found and deleted.
export function containerName(routeId: string) {
  return `relayrunner-${routeId.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

// `container run` arguments for one job. The JIT config travels in the environment (`-e NAME`
// copies it from ours), so it never shows in this machine's process list.
export function runArgs(routeId: string, isolation: Isolation) {
  return [
    "run",
    "--rm",
    "--name",
    containerName(routeId),
    "--cpus",
    String(isolation.cpus),
    "--memory",
    `${isolation.memoryGb}g`,
    // No image download or boot progress in the job's output.
    "--progress",
    "none",
    "-e",
    "RUNNER_JIT_CONFIG",
    // GitHub's image prints the runner's diagnostic log to stdout, thousands of lines a job.
    "-e",
    "ACTIONS_RUNNER_PRINT_LOG_TO_STDOUT=false",
    ...(isolation.localNetwork ? ["-e", "RELAYRUNNER_LOCAL_NETWORK=1"] : []),
    // Root and every capability are for the start script's firewall and for Docker. The runner
    // itself starts as `runner`.
    "--user",
    "0",
    "--cap-add",
    "ALL",
    isolation.image,
    START_PATH,
  ];
}

// Runs each job's runner inside a fresh VM.
export function isolatedLauncher(isolation: Isolation): Launcher {
  const { command, debug } = isolation;
  return {
    start(run) {
      const name = containerName(run.routeId);
      const args = runArgs(run.routeId, isolation);
      debug.write(`$ ${command} ${args.join(" ")}`);
      const child = spawn(command, args, {
        env: { ...runnerEnv(), RUNNER_JIT_CONFIG: run.jitConfig },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.once("error", (error) => debug.write(`${name}: ${error.message}`));
      child.once("close", (code, signal) => debug.write(`${name}: exit ${signal ?? code}`));
      return child;
    },
    // `--rm` deletes the VM when the runner exits with 0. Anything else may have left it behind,
    // such as a `container run` that was stopped before its VM was.
    // The first delete can fail while the VM's processes are still being killed, so it gets a
    // second try.
    async cleanup(run, clean) {
      if (clean) return;
      const args = ["delete", "--force", containerName(run.routeId)];
      if ((await call(command, args, debug)) !== 0) await call(command, args, debug);
    },
  };
}

// Runs a `container` command to the end and records it in the debug log, with what it printed
// unless `quiet`. Resolves with its exit code, or null when it couldn't start.
function call(command: string, args: string[], debug: DebugLog, quiet = false) {
  return new Promise<number | null>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const keep = (chunk: Buffer) => {
      if (!quiet) output += chunk.toString();
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const done = (code: number | null, extra = "") => {
      debug.write(`$ ${command} ${args.join(" ")}\n${output}${extra}exit ${code}`);
      resolve(code);
    };
    child.once("error", (error) => done(null, `${error.message}\n`));
    child.once("close", (code) => done(code));
  });
}
