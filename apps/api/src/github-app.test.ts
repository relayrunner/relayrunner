import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  appInstallationToken,
  appJwt,
  clearInstallationTokens,
  deleteRunner,
  generateJitConfig,
  importAppPrivateKey,
  listRunners,
  runnerBusy,
  runnerScope,
} from "./github-app.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pkcs1 = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8 = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const publicKey = createPublicKey(privateKey);

function verifies(jwt: string) {
  const [header, payload, signature] = jwt.split(".");
  return verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    publicKey,
    Buffer.from(signature, "base64url"),
  );
}

describe("GitHub App auth", () => {
  test.each([
    ["PKCS#8", pkcs8],
    ["PKCS#1 (GitHub download)", pkcs1],
    ["PKCS#1 pasted without line breaks", pkcs1.replace(/\n/g, " ")],
    ["PKCS#8 pasted without line breaks", pkcs8.replace(/\n/g, "")],
  ])("signs a verifiable App JWT from a %s key", async (_name, pem) => {
    const jwt = await appJwt("5605512", await importAppPrivateKey(pem), Date.UTC(2026, 10, 4));
    expect(verifies(jwt)).toBe(true);
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
    expect(claims).toEqual({
      iss: "5605512",
      iat: Date.UTC(2026, 10, 4) / 1000 - 60,
      exp: Date.UTC(2026, 10, 4) / 1000 + 480,
    });
  });
});

describe("installation tokens", () => {
  const env = { GITHUB_APP_ID: "5605512", GITHUB_APP_PRIVATE_KEY: { get: async () => pkcs8 } };
  const now = Date.UTC(2026, 10, 10, 2);
  let mints: number;

  beforeEach(() => {
    clearInstallationTokens();
    mints = 0;
    vi.stubGlobal("fetch", async () => {
      mints += 1;
      return Response.json({
        token: `ghs_${mints}`,
        expires_at: new Date(now + 60 * 60_000).toISOString(),
      });
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("reuses a token until 5 minutes before it expires", async () => {
    expect(await appInstallationToken(env, 1, now)).toBe("ghs_1");
    expect(await appInstallationToken(env, 1, now + 54 * 60_000)).toBe("ghs_1");
    expect(mints).toBe(1);
    expect(await appInstallationToken(env, 1, now + 56 * 60_000)).toBe("ghs_2");
  });

  test("keeps each installation's token apart", async () => {
    expect(await appInstallationToken(env, 1, now)).toBe("ghs_1");
    expect(await appInstallationToken(env, 2, now)).toBe("ghs_2");
    expect(await appInstallationToken(env, 1, now)).toBe("ghs_1");
  });
});

describe("runner scope", () => {
  test("a personal (User) install registers on the job's repo, an org install in the org", () => {
    expect(runnerScope("User", "atticoos/side-project")).toEqual({
      kind: "repo",
      repo: "atticoos/side-project",
    });
    expect(runnerScope("Organization", "relayrunner/relayrunner")).toEqual({
      kind: "org",
      org: "relayrunner",
    });
    // An installation RelayRunner hasn't recorded keeps the old org behavior.
    expect(runnerScope(undefined, "relayrunner/relayrunner")).toEqual({
      kind: "org",
      org: "relayrunner",
    });
  });
});

describe("JIT runners by scope", () => {
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = [];
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json({
        runner: { id: 7, labels: [{ name: "relayrunner" }] },
        encoded_jit_config: "abc",
        busy: true,
      });
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const repo = { kind: "repo", repo: "atticoos/side-project" } as const;
  const org = { kind: "org", org: "relayrunner" } as const;

  test("a repo runner uses the repo endpoints and the Default group", async () => {
    const jit = await generateJitConfig("t", repo, { name: "pick", labels: ["relayrunner"] });
    expect(jit).toEqual({ runnerId: 7, labels: ["relayrunner"], encodedJitConfig: "abc" });
    await runnerBusy("t", repo, 7);
    await deleteRunner("t", repo, 7);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.github.com/repos/atticoos/side-project/actions/runners/generate-jitconfig",
      "GET https://api.github.com/repos/atticoos/side-project/actions/runners/7",
      "DELETE https://api.github.com/repos/atticoos/side-project/actions/runners/7",
    ]);
    expect(calls[0].body?.runner_group_id).toBe(1);
  });

  test("lists a repo's runners for the sweep", async () => {
    await listRunners("t", repo);
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/atticoos/side-project/actions/runners?per_page=100&page=1",
    );
  });

  test("a repo runner ignores a runner group, which only orgs have", async () => {
    await generateJitConfig("t", repo, { name: "c", labels: ["x"], runnerGroupId: 4 });
    expect(calls[0].body?.runner_group_id).toBe(1);
  });

  test("an org runner uses the org endpoints and the given group", async () => {
    await generateJitConfig("t", org, { name: "c", labels: ["x"], runnerGroupId: 4 });
    await generateJitConfig("t", org, { name: "pick", labels: ["relayrunner"] });
    await deleteRunner("t", org, 7);
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST https://api.github.com/orgs/relayrunner/actions/runners/generate-jitconfig",
      "POST https://api.github.com/orgs/relayrunner/actions/runners/generate-jitconfig",
      "DELETE https://api.github.com/orgs/relayrunner/actions/runners/7",
    ]);
    expect(calls.map((call) => call.body?.runner_group_id)).toEqual([4, 1, undefined]);
  });
});
