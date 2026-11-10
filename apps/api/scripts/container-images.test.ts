import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  contentTag,
  dockerfileImages,
  parseJsonc,
  withRegistryImages,
} from "./container-images.ts";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "container-images-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const config = `{
  "name": "relayrunner-api", // trailing comment with "quotes"
  /* block comment */
  "account_id": "abc",
  "vars": { "URL": "https://example.com/*not-a-comment*/", },
  "containers": [
    { "class_name": "ContainerRunner", "images": { "runner": { "dockerfile": "./container/Dockerfile" } } },
    { "class_name": "LintRunner", "images": { "lint": { "dockerfile": "../lint/Dockerfile" } } },
  ],
}`;

describe("parseJsonc", () => {
  it("drops comments and trailing commas but not comment-like text in strings", () => {
    const parsed = parseJsonc(config) as { vars: { URL: string }; containers: unknown[] };
    expect(parsed.vars.URL).toBe("https://example.com/*not-a-comment*/");
    expect(parsed.containers).toHaveLength(2);
  });

  it("parses the real wrangler.jsonc", () => {
    const parsed = parseJsonc(readFileSync(join(apiDir, "wrangler.jsonc"), "utf8")) as {
      name: string;
    };
    expect(parsed.name).toBe("relayrunner-api");
  });
});

describe("dockerfileImages", () => {
  it("names each repository the way wrangler deploy does", () => {
    const images = dockerfileImages(config, "/repo/apps/api");
    expect(images.map((image) => [image.repository, image.context])).toEqual([
      ["relayrunner-api-containerrunner-runner", "/repo/apps/api/container"],
      ["relayrunner-api-lintrunner-lint", "/repo/apps/lint"],
    ]);
  });

  it("finds both images in the real wrangler.jsonc", () => {
    const images = dockerfileImages(readFileSync(join(apiDir, "wrangler.jsonc"), "utf8"), apiDir);
    expect(images.map((image) => image.imageName)).toEqual(["runner", "lint"]);
  });

  it("rejects build_context, which wrangler containers build can't take", () => {
    const withContext = `{ "name": "w", "containers": [{ "class_name": "C", "images": { "x": { "dockerfile": "./Dockerfile", "build_context": ".." } } }] }`;
    expect(() => dockerfileImages(withContext, "/repo")).toThrow(/build_context/);
  });
});

describe("contentTag", () => {
  const image = (context: string) => ({
    className: "C",
    imageName: "x",
    dockerfile: "./Dockerfile",
    dockerfilePath: join(context, "Dockerfile"),
    context,
    repository: "w-c-x",
  });

  it("is the same for the same files and changes with any file", () => {
    const files = { Dockerfile: "FROM node:24\n", "src/server.ts": "console.log(1);\n" };
    const a = fixture(files);
    const b = fixture({ ...files, "node_modules/ignored.js": "x" });
    const c = fixture({ ...files, "src/server.ts": "console.log(2);\n" });
    expect(contentTag(image(a))).toMatch(/^[0-9a-f]{16}$/);
    expect(contentTag(image(a))).toBe(contentTag(image(b)));
    expect(contentTag(image(a))).not.toBe(contentTag(image(c)));
  });

  it("changes when a file moves", () => {
    const a = fixture({ Dockerfile: "FROM node:24\n", "a.ts": "x" });
    const b = fixture({ Dockerfile: "FROM node:24\n", "b.ts": "x" });
    expect(contentTag(image(a))).not.toBe(contentTag(image(b)));
  });
});

describe("withRegistryImages", () => {
  it("swaps each dockerfile for its image and keeps everything else", () => {
    const images = dockerfileImages(config, "/repo/apps/api");
    const ref = (repository: string) =>
      `registry.cloudflare.com/abc/${repository}@sha256:${"0".repeat(64)}`;
    const out = withRegistryImages(
      config,
      images.map((image) => ({ image, ref: ref(image.repository) })),
    );
    expect(out).not.toContain('"dockerfile"');
    expect(out).toContain(`"image": "${ref("relayrunner-api-lintrunner-lint")}"`);
    expect(out).toContain("// trailing comment");
    expect(dockerfileImages(out, "/repo/apps/api")).toEqual([]);
  });

  it("throws when an entry isn't written the expected way", () => {
    const [image] = dockerfileImages(config, "/repo/apps/api");
    expect(() =>
      withRegistryImages(
        config.replace('"dockerfile": "./container', '"dockerfile":"./container'),
        [{ image: image!, ref: "x" }],
      ),
    ).toThrow(/found it 0 times/);
  });
});
