// Helpers for scripts/deploy.ts: find the Dockerfile images in wrangler.jsonc, tag each one by a
// hash of its build context, and write a deploy config that points at the pushed images instead.
// wrangler.jsonc keeps `dockerfile:` so `wrangler dev` still builds the images locally.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export type DockerfileImage = {
  className: string;
  imageName: string;
  /** The `dockerfile` value exactly as written in wrangler.jsonc. */
  dockerfile: string;
  /** Absolute path of the build context, the Dockerfile's directory. */
  context: string;
  /** Absolute path of the Dockerfile. */
  dockerfilePath: string;
  /** The managed-registry repository, named the way `wrangler deploy` names it. */
  repository: string;
};

type ContainerImageConfig = {
  dockerfile?: string;
  build_context?: string;
  build_vars?: Record<string, string>;
  image?: string;
};

type WranglerConfig = {
  name: string;
  account_id?: string;
  containers?: { class_name: string; images?: Record<string, ContainerImageConfig> }[];
};

/** Parses JSONC: drops comments and trailing commas, leaving strings alone. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') {
      const start = i;
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
      i++;
      out += text.slice(start, i);
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function dockerfileImages(configText: string, configDir: string): DockerfileImage[] {
  const config = parseJsonc(configText) as WranglerConfig;
  const images: DockerfileImage[] = [];
  for (const container of config.containers ?? []) {
    for (const [imageName, image] of Object.entries(container.images ?? {})) {
      if (image.dockerfile === undefined) continue;
      const field = `containers[${container.class_name}].images.${imageName}`;
      // `wrangler containers build <dir>` builds <dir>/Dockerfile with <dir> as the context and
      // takes no build vars, so only that shape can be prebuilt.
      if (image.build_context !== undefined || image.build_vars !== undefined) {
        throw new Error(
          `${field}: build_context and build_vars aren't supported by scripts/deploy.ts.`,
        );
      }
      if (basename(image.dockerfile) !== "Dockerfile") {
        throw new Error(`${field}: the Dockerfile must be named Dockerfile.`);
      }
      const dockerfilePath = resolve(configDir, image.dockerfile);
      images.push({
        className: container.class_name,
        imageName,
        dockerfile: image.dockerfile,
        dockerfilePath,
        context: dirname(dockerfilePath),
        repository: `${config.name}-${container.class_name}-${imageName}`
          .toLowerCase()
          .replace(/[^a-z0-9._-]+/g, "-")
          .replace(/^-+|-+$/g, ""),
      });
    }
  }
  return images;
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.name !== "node_modules" && entry.name !== ".wrangler")
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
    })
    .sort();
}

/**
 * A tag that changes only when the image's inputs do: every file in the build context, Dockerfile
 * included. A change to a file the build ignores (a README, a test) also changes it, which only
 * costs one extra build.
 */
export function contentTag(image: DockerfileImage): string {
  const hash = createHash("sha256");
  for (const file of listFiles(image.context)) {
    hash.update(`${relative(image.context, file)}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * Swaps each image's `"dockerfile": "…"` for `"image": "…"`, keeping the rest of the file (and its
 * comments) as written. Throws if an entry isn't written the expected way.
 */
export function withRegistryImages(
  configText: string,
  refs: { image: DockerfileImage; ref: string }[],
): string {
  let text = configText;
  for (const { image, ref } of refs) {
    const entry = `"dockerfile": ${JSON.stringify(image.dockerfile)}`;
    const count = text.split(entry).length - 1;
    if (count !== 1) {
      throw new Error(`Expected ${entry} once in wrangler.jsonc, found it ${count} times.`);
    }
    text = text.replace(entry, `"image": ${JSON.stringify(ref)}`);
  }
  return text;
}
