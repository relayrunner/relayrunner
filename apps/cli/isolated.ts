// `connect --isolated`: each job runs in its own Linux VM instead of on this machine, using
// Apple's `container` tool (https://github.com/apple/container). The VM starts from GitHub's
// runner image with nothing of the Mac mounted, takes one job and is deleted, so a job can't read
// the user's files, the machine token, or anything an earlier job left behind. A firewall inside
// the VM keeps the job off the local network: it reaches the internet, not the Mac or the LAN.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { exitCode, latestRunnerVersion, RunnerError } from "./install.ts";
import { runnerEnv, type Launcher } from "./job.ts";

export interface Isolation {
  // The `container` binary. Tests point it at a stand-in.
  command: string;
  // The image each job's VM starts from: the runner image plus the firewall (jobImage).
  image: string;
  // The actions/runner version in that image, when it's GitHub's own.
  runnerVersion: string;
  // Each VM's share of this machine.
  cpus: number;
  memoryGb: number;
}

// GitHub's runner image, tagged by actions/runner version. It runs as `runner` in /home/runner.
const RUNNER_IMAGE = "ghcr.io/actions/actions-runner";
const RELEASES = "https://github.com/apple/container/releases";

// What the VM runs, as root with NET_ADMIN, before the runner. It loads a firewall that lets the
// job reach the internet and DNS but not private addresses (the Mac, the LAN, link-local) or any
// IPv6 address, then starts the runner as `runner` with NET_ADMIN and NET_RAW gone for good. Without
// NET_ADMIN not even `sudo` in a job step can take the firewall down, and without NET_RAW it can't
// send raw packets underneath it.
export const START_SCRIPT = `#!/bin/sh
set -eu
dns=$(awk '$1 == "nameserver" && $2 ~ /^[0-9.]+$/ { printf "%s%s", sep, $2; sep = ", " }' /etc/resolv.conf)
allow_dns=""
[ -z "$dns" ] || allow_dns="ip daddr { $dns } meta l4proto { tcp, udp } th dport 53 accept"
nft -f - <<EOF
table inet relayrunner {
  chain out {
    type filter hook output priority 0; policy accept;
    oifname "lo" accept
    $allow_dns
    ip daddr { 10.0.0.0/8, 100.64.0.0/10, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } drop
    meta nfproto ipv6 drop
  }
}
EOF
cd /home/runner
# With arguments, runs them in place of the runner, to check the firewall by hand.
[ $# -gt 0 ] || set -- ./run.sh --jitconfig "$RUNNER_JIT_CONFIG"
exec setpriv --reuid runner --regid runner --init-groups --bounding-set -net_admin,-net_raw \\
  env HOME=/home/runner USER=runner LOGNAME=runner "$@"
`;

const START_PATH = "/usr/local/bin/relayrunner-start";

// The job image: a runner image with nftables and the start script added.
export function dockerfile(base: string) {
  return `FROM ${base}
USER root
RUN apt-get update && apt-get install -y --no-install-recommends nftables && apt-get clean
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

// Checks Apple's container tool is running and builds the job image if it isn't here yet, so the
// first job doesn't wait for it. Throws a RunnerError that says what to do otherwise.
export async function prepareIsolation(options: {
  slots: number;
  // Another runner image to build on. It needs apt and a `runner` user in /home/runner.
  image?: string;
  command?: string;
  log?: (line: string) => void;
}): Promise<Isolation> {
  const command = options.command ?? "container";
  const log = options.log ?? (() => {});

  const status = await exitCode(command, ["system", "status"]);
  if (status === null)
    throw new RunnerError(
      "ISOLATED_SETUP",
      `--isolated needs Apple's container tool. Install it from ${RELEASES}, then run \`container system start\`.`,
    );
  if (status !== 0)
    throw new RunnerError(
      "ISOLATED_SETUP",
      "Apple's container tool isn't running. Run `container system start`, then try again.",
    );

  const runnerVersion = await latestRunnerVersion(log);
  const base = options.image ?? `${RUNNER_IMAGE}:${runnerVersion}`;
  const image = jobImage(base);
  if ((await exitCode(command, ["image", "inspect", image])) !== 0) {
    log(`Building the job image from ${base}. This happens once per runner version…`);
    const context = mkdtempSync(join(tmpdir(), "relayrunner-image-"));
    try {
      writeFileSync(join(context, "Dockerfile"), dockerfile(base));
      writeFileSync(join(context, "start.sh"), START_SCRIPT);
      const build = await captured(command, [
        "build",
        "--progress",
        "plain",
        "--tag",
        image,
        context,
      ]);
      if (build.code !== 0) {
        process.stderr.write(build.output);
        throw new RunnerError("ISOLATED_IMAGE", `Could not build the job image from ${base}.`);
      }
    } finally {
      rmSync(context, { recursive: true, force: true });
      // The build leaves Apple's builder VM running. It starts again by itself when needed.
      await exitCode(command, ["builder", "stop"]);
    }
  }
  return { command, image, runnerVersion, ...vmSize(options.slots) };
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
    // Root and NET_ADMIN are for the start script's firewall. It gives both up before the
    // runner starts.
    "--user",
    "0",
    "--cap-add",
    "NET_ADMIN",
    isolation.image,
    START_PATH,
  ];
}

// Runs each job's runner inside a fresh VM.
export function isolatedLauncher(isolation: Isolation): Launcher {
  return {
    start: (run) =>
      spawn(isolation.command, runArgs(run.routeId, isolation), {
        env: { ...runnerEnv(), RUNNER_JIT_CONFIG: run.jitConfig },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    // `--rm` deletes the VM when the runner exits with 0. Anything else may have left it behind,
    // such as a `container run` that was stopped before its VM was.
    // The first delete can fail while the VM's processes are still being killed, so it gets a
    // second try.
    async cleanup(run, clean) {
      if (clean) return;
      const args = ["delete", "--force", containerName(run.routeId)];
      if ((await exitCode(isolation.command, args)) !== 0) await exitCode(isolation.command, args);
    },
  };
}

// Runs a command to the end, keeping what it printed for when it fails.
function captured(command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.once("error", (error) => resolve({ code: null, output: `${error.message}\n` }));
    child.once("close", (code) => resolve({ code, output }));
  });
}
