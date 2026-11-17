// Makes the npm tarballs for a release of the Rust CLI: one package per platform holding its
// binary, and `relayrunner` itself, which only holds apps/cli/bin/relayrunner.js and depends on
// every platform package as optional, so npm installs just the one for the computer it's on.
//
//   node scripts/npm-packages.mjs <binaries dir> <out dir> [--allow-missing]
//
// The binaries dir holds relayrunner-<os>-<arch> for each platform in PLATFORMS. Every package
// takes apps/cli/package.json's version. The tarballs land in <out dir>, platform packages first,
// in the order to publish them; their paths are printed one per line. A missing binary is an
// error, unless --allow-missing (for smoke tests on one platform), which skips that package.

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

// os and cpu as npm and Node name them, and the Rust target each is built for.
export const PLATFORMS = [
  { os: "darwin", cpu: "arm64", target: "aarch64-apple-darwin", name: "macOS on Apple silicon" },
  { os: "darwin", cpu: "x64", target: "x86_64-apple-darwin", name: "macOS on Intel" },
  { os: "linux", cpu: "arm64", target: "aarch64-unknown-linux-musl", name: "Linux on arm64" },
  { os: "linux", cpu: "x64", target: "x86_64-unknown-linux-musl", name: "Linux on x64" },
];
export const packageName = ({ os, cpu }) => `@relayrunner/cli-${os}-${cpu}`;

const root = resolve(import.meta.dirname, "..");
const cli = JSON.parse(readFileSync(join(root, "apps/cli/package.json"), "utf8"));

function pack(dir, out) {
  const name = execFileSync("npm", ["pack", "--pack-destination", out], {
    cwd: dir,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .pop();
  return join(out, name);
}

function main(args) {
  const allowMissing = args.includes("--allow-missing");
  let [binaries, out] = args.filter((arg) => !arg.startsWith("--"));
  if (!binaries || !out) {
    console.error("Usage: node scripts/npm-packages.mjs <binaries dir> <out dir>");
    process.exit(2);
  }
  out = resolve(out);
  const stage = join(out, "stage");
  const shared = {
    version: cli.version,
    license: cli.license,
    repository: { ...cli.repository, directory: "apps/cli-rs" },
  };
  const tarballs = [];
  for (const platform of PLATFORMS) {
    const binary = join(binaries, `relayrunner-${platform.os}-${platform.cpu}`);
    if (!existsSync(binary)) {
      if (allowMissing) continue;
      throw new Error(`No binary at ${binary}.`);
    }
    const dir = join(stage, `cli-${platform.os}-${platform.cpu}`);
    mkdirSync(dir, { recursive: true });
    copyFileSync(binary, join(dir, "relayrunner"));
    chmodSync(join(dir, "relayrunner"), 0o755);
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          name: packageName(platform),
          ...shared,
          description: `The relayrunner CLI for ${platform.name}. Install relayrunner, which picks this for you.`,
          os: [platform.os],
          cpu: [platform.cpu],
          files: ["relayrunner"],
          preferUnplugged: true,
        },
        null,
        2,
      )}\n`,
    );
    tarballs.push(pack(dir, out));
  }

  const dir = join(stage, "relayrunner");
  mkdirSync(join(dir, "bin"), { recursive: true });
  copyFileSync(join(root, "apps/cli/bin/relayrunner.js"), join(dir, "bin/relayrunner.js"));
  chmodSync(join(dir, "bin/relayrunner.js"), 0o755);
  for (const file of ["README.md", "LICENSE", "CHANGELOG.md"]) {
    if (existsSync(join(root, "apps/cli", file)))
      copyFileSync(join(root, "apps/cli", file), join(dir, file));
  }
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: cli.name,
        ...shared,
        description: cli.description,
        repository: cli.repository,
        type: "module",
        engines: cli.engines,
        bin: { relayrunner: "./bin/relayrunner.js" },
        files: ["bin"],
        optionalDependencies: Object.fromEntries(
          PLATFORMS.map((platform) => [packageName(platform), cli.version]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  tarballs.push(pack(dir, out));
  console.log(tarballs.join("\n"));
}

if (import.meta.main ?? process.argv[1] === import.meta.filename) main(process.argv.slice(2));
