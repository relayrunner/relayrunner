import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { decodeJitConfig, latestRunnerVersion, RunnerClient } from "./runner-protocol.ts";
import type { JitConfig, JobRequest } from "./runner-protocol.ts";

const broker = "https://broker.test/runner";
const tokenUrl = "https://auth.test/token";
const service = "https://run.test/service";

let jit: JitConfig;
let publicKey: CryptoKey;

const fromBase64Url = (value: string) => Buffer.from(value, "base64url").toString("base64");
const encodeFile = (value: unknown) => Buffer.from(`﻿${JSON.stringify(value)}`).toString("base64");

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSA-PSS",
      hash: "SHA-256",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  publicKey = pair.publicKey;
  const key = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const encoded = Buffer.from(
    JSON.stringify({
      ".runner": encodeFile({ AgentId: "12", AgentName: "pick-1", ServerUrlV2: broker }),
      ".credentials": encodeFile({ Data: { ClientId: "client", AuthorizationUrl: tokenUrl } }),
      ".credentials_rsaparams": encodeFile({
        d: fromBase64Url(key.d!),
        dp: fromBase64Url(key.dp!),
        dq: fromBase64Url(key.dq!),
        exponent: fromBase64Url(key.e!),
        inverseQ: fromBase64Url(key.qi!),
        modulus: fromBase64Url(key.n!),
        p: fromBase64Url(key.p!),
        q: fromBase64Url(key.q!),
      }),
    }),
  ).toString("base64");
  jit = decodeJitConfig(encoded);
});

afterEach(() => vi.unstubAllGlobals());

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function stubFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const call = {
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ""),
    };
    calls.push(call);
    if (url === tokenUrl) return Response.json({ access_token: "runner-token", expires_in: 3600 });
    return respond(call);
  });
  return calls;
}

async function openedClient(respond: (call: Call) => Response) {
  const calls = stubFetch((call) =>
    call.url === `${broker}/session` ? Response.json({ sessionId: "session-1" }) : respond(call),
  );
  const client = new RunnerClient(jit, "2.338.2");
  await client.openSession();
  return { client, calls };
}

test("decodeJitConfig reads the runner files", () => {
  expect(jit.runner.AgentName).toBe("pick-1");
  expect(jit.credentials.Data.ClientId).toBe("client");
});

test("signs a PS256 client assertion for the token request", async () => {
  const { calls } = await openedClient(() => new Response(null));
  const assertion = new URLSearchParams(calls[0].body).get("client_assertion")!;
  const [header, payload, signature] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  expect(JSON.parse(Buffer.from(header, "base64url").toString()).alg).toBe("PS256");
  expect(claims).toMatchObject({ iss: "client", sub: "client", aud: tokenUrl });
  await expect(
    crypto.subtle.verify(
      { name: "RSA-PSS", saltLength: 32 },
      publicKey,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  ).resolves.toBe(true);
});

test("opens a session as the registered runner", async () => {
  const { calls } = await openedClient(() => new Response(null));
  expect(JSON.parse(calls[1].body).agent).toMatchObject({
    id: 12,
    name: "pick-1",
    version: "2.338.2",
  });
  expect(calls[1].headers.authorization).toBe("Bearer runner-token");
});

describe("poll", () => {
  const request: JobRequest = { runner_request_id: "request-1", run_service_url: service };

  test("returns a job request", async () => {
    const { client, calls } = await openedClient(() =>
      Response.json({ messageType: "RunnerJobRequest", body: JSON.stringify(request) }),
    );
    await expect(client.poll()).resolves.toEqual(request);
    expect(new URL(calls.at(-1)!.url).searchParams.get("runnerVersion")).toBe("2.338.2");
  });

  test("returns null for an empty poll or another message type", async () => {
    const { client } = await openedClient((call) =>
      call.url.includes("sessionId") ? new Response(null, { status: 202 }) : new Response(null),
    );
    await expect(client.poll()).resolves.toBeNull();
    const other = await openedClient(() =>
      Response.json({ messageType: "RunnerRefresh", body: "{}" }),
    );
    await expect(other.client.poll()).resolves.toBeNull();
  });

  test("rejects encrypted messages", async () => {
    const { client } = await openedClient(() =>
      Response.json({ messageType: "RunnerJobRequest", body: "x", iv: "y" }),
    );
    await expect(client.poll()).rejects.toThrow("Encrypted job messages");
  });

  test("surfaces the version gate", async () => {
    const { client } = await openedClient(
      () => new Response("Runner version is deprecated", { status: 403 }),
    );
    await expect(client.poll()).rejects.toThrow("status 403");
  });
});

describe("claim and complete", () => {
  const job = {
    jobId: "job-1",
    jobDisplayName: "pick",
    billingOwnerId: "owner",
    plan: { planId: "plan-1" },
    resources: {
      endpoints: [
        {
          name: "SystemVssConnection",
          url: `${service}/job`,
          authorization: { parameters: { AccessToken: "job-token" } },
        },
      ],
    },
  };
  const request: JobRequest = {
    runner_request_id: "request-1",
    run_service_url: service,
    billing_owner_id: "owner",
  };

  test("acknowledges and acquires a job", async () => {
    const { client, calls } = await openedClient((call) =>
      call.url.endsWith("/acquirejob") ? Response.json(job) : new Response(null),
    );
    const claimed = await client.claim(request);
    expect(claimed).toMatchObject({ token: "job-token", serviceUrl: `${service}/job` });
    expect(calls.map((call) => new URL(call.url).pathname).slice(-2)).toEqual([
      "/runner/acknowledge",
      "/service/acquirejob",
    ]);
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ jobMessageId: "request-1" });
  });

  test("skips acknowledgement when GitHub does not ask for it", async () => {
    const { client, calls } = await openedClient(() => Response.json(job));
    await client.claim({ ...request, should_acknowledge: false });
    expect(calls.some((call) => call.url.includes("/acknowledge"))).toBe(false);
  });

  test("reports the output with the job token", async () => {
    const { client, calls } = await openedClient((call) =>
      call.url.endsWith("/acquirejob") ? Response.json(job) : new Response(null, { status: 204 }),
    );
    await client.complete(await client.claim(request), "succeeded", {
      outputs: { runner: '"ubuntu-24.04"' },
    });
    const completed = calls.at(-1)!;
    expect(completed.url).toBe(`${service}/job/completejob`);
    expect(completed.headers.authorization).toBe("Bearer job-token");
    expect(JSON.parse(completed.body)).toMatchObject({
      planId: "plan-1",
      jobId: "job-1",
      conclusion: "succeeded",
      outputs: { runner: { value: '"ubuntu-24.04"', isSecret: false } },
    });
  });

  test("fails the job with the reason as a failure annotation", async () => {
    const { client, calls } = await openedClient((call) =>
      call.url.endsWith("/acquirejob") ? Response.json(job) : new Response(null, { status: 204 }),
    );
    await client.complete(await client.claim(request), "failed", { error: "No runner available." });
    const body = JSON.parse(calls.at(-1)!.body);
    expect(body).toMatchObject({
      conclusion: "failed",
      outputs: {},
      annotations: [{ level: "FAILURE", message: "No runner available." }],
    });
  });

  test("still fails the job when GitHub turns the annotation down", async () => {
    const { client, calls } = await openedClient((call) => {
      if (call.url.endsWith("/acquirejob")) return Response.json(job);
      if (call.url.endsWith("/completejob") && call.body.includes("annotations"))
        return new Response("bad annotation", { status: 400 });
      return new Response(null, { status: 204 });
    });
    await client.complete(await client.claim(request), "failed", { error: "No runner available." });
    const completions = calls.filter((call) => call.url.endsWith("/completejob"));
    expect(completions).toHaveLength(2);
    expect(JSON.parse(completions[1].body)).toMatchObject({ conclusion: "failed" });
    expect(JSON.parse(completions[1].body)).not.toHaveProperty("annotations");
  });
});

test("closeSession deletes the session once", async () => {
  const { client, calls } = await openedClient(() => new Response(null, { status: 204 }));
  await client.closeSession();
  await client.closeSession();
  expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});

test("latestRunnerVersion reads the release redirect", async () => {
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://github.com/actions/runner/releases/tag/v2.338.2" },
      }),
  );
  await expect(latestRunnerVersion()).resolves.toBe("2.338.2");
  vi.stubGlobal("fetch", async () => new Response(null, { status: 429 }));
  await expect(latestRunnerVersion()).rejects.toThrow("Status 429");
});
