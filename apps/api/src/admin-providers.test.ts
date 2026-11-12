import type { CatalogProvider } from "@relayrunner/providers/catalog";
import { beforeAll, describe, expect, test } from "vitest";
import { app } from "./app.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { environmentFor } from "./job-times.ts";
import { loadCatalog } from "./provider-catalog.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

let env: Env;

beforeAll(async () => {
  env = { ...(await testing.createTestEnv()), ...accessEnv };
});

async function call(path: string, cookie: string, init: RequestInit = {}, base = "providers") {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("Cf-Access-Jwt-Assertion", await accessJwt());
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`/api/admin/${base}${path}`, { ...init, headers }, env);
}

async function operator() {
  const signedIn = await testing.signIn(env);
  await env.DB.prepare("update user set role = 'operator' where id = ?")
    .bind(signedIn.user.id)
    .run();
  return signedIn;
}

const send = (cookie: string, method: string, path: string, body: object) =>
  call(path, cookie, { method, body: JSON.stringify(body) });

async function providers(cookie: string) {
  return ((await (await call("", cookie)).json()) as { providers: CatalogProvider[] }).providers;
}

const acme = {
  id: "acme",
  name: "Acme",
  summary: "Hosted runners for GitHub Actions.",
  labels: "acme-*",
  prefixes: ["acme-"],
  docsUrl: "https://acme.example/docs",
};

describe("/api/admin/providers", () => {
  test("is for operators only", async () => {
    const regular = await testing.signIn(env);
    expect((await call("", regular.cookie)).status).toBe(403);
    expect((await send(regular.cookie, "POST", "", acme)).status).toBe(403);
  });

  test("lists the code list, with Other last", async () => {
    const op = await operator();
    const list = await providers(op.cookie);
    expect(list[0]).toMatchObject({ id: "blacksmith", builtIn: true, updatedBy: null });
    expect(list.at(-1)?.id).toBe("other");
  });

  test("editing a provider in code changes its text, and removing the row resets it", async () => {
    const op = await operator();
    const depot = (await providers(op.cookie)).find((p) => p.id === "depot")!;
    const res = await send(op.cookie, "PUT", "/depot", {
      ...depot,
      summary: "Fast hosted runners.",
      prefixes: ["nope-"],
    });
    expect(res.status).toBe(200);
    const edited = (await providers(op.cookie)).find((p) => p.id === "depot")!;
    expect(edited).toMatchObject({
      summary: "Fast hosted runners.",
      prefixes: ["depot-"],
      updatedBy: op.user.email,
    });

    expect((await call("/depot", op.cookie, { method: "DELETE" })).status).toBe(200);
    const reset = (await providers(op.cookie)).find((p) => p.id === "depot")!;
    expect(reset).toMatchObject({ summary: depot.summary, updatedBy: null });
  });

  test("an added provider is matched by its prefixes at once, and can be removed", async () => {
    const op = await operator();
    expect((await send(op.cookie, "POST", "", { ...acme, prefixes: ["depot-x"] })).status).toBe(
      400,
    );
    expect((await send(op.cookie, "POST", "", { ...acme, prefixes: ["ubuntu-"] })).status).toBe(
      400,
    );
    expect((await send(op.cookie, "POST", "", { ...acme, id: "depot" })).status).toBe(409);
    expect((await send(op.cookie, "POST", "", { ...acme, docsUrl: "http://x" })).status).toBe(400);

    expect((await send(op.cookie, "POST", "", acme)).status).toBe(201);
    expect((await send(op.cookie, "POST", "", acme)).status).toBe(409);
    const list = await providers(op.cookie);
    expect(list.at(-2)).toMatchObject({ id: "acme", builtIn: false, prefixes: ["acme-"] });

    await loadCatalog(createDb(env.DB));
    expect(environmentFor(["acme-4cpu"], null, null)).toEqual({
      key: "acme:acme-4cpu",
      label: "acme-4cpu",
      detail: "Acme",
    });

    expect((await call("/acme", op.cookie, { method: "DELETE" })).status).toBe(200);
    expect((await providers(op.cookie)).some((p) => p.id === "acme")).toBe(false);
    expect(environmentFor(["acme-4cpu"], null, null).key).not.toMatch(/^acme:/);
  });

  test("an added provider keeps its logo and takes a per-runner price", async () => {
    const op = await operator();
    const logoUrl = "https://acme.example/logo.png";
    const added = { ...acme, id: "acme-two", name: "Acme Two", prefixes: ["acmetwo-"], logoUrl };
    expect((await send(op.cookie, "POST", "", added)).status).toBe(201);
    const depot = (await providers(op.cookie)).find((p) => p.id === "depot")!;
    expect((await send(op.cookie, "PUT", "/depot", { ...depot, logoUrl })).status).toBe(200);
    const list = await providers(op.cookie);
    expect(list.find((p) => p.id === "acme-two")?.logoUrl).toBe(logoUrl);
    expect(list.find((p) => p.id === "depot")?.logoUrl).toBeUndefined();

    const prices = (init: RequestInit = {}) => call("", op.cookie, init, "prices");
    const price = (provider: string, rate: string) =>
      prices({
        method: "POST",
        body: JSON.stringify({ provider, rate, usd: 0.004, from: "2026-11-01" }),
      });
    expect((await price("acme-two", "runner")).status).toBe(201);
    expect((await price("acme-two", "linux")).status).toBe(400);
    expect((await price("namespace", "runner")).status).toBe(400);
    expect((await price("nobody", "runner")).status).toBe(400);
    const { rates } = (await (await prices()).json()) as {
      rates: { provider: string; rate: string; current: number | null }[];
    };
    expect(rates.find((r) => r.provider === "acme-two")).toMatchObject({
      rate: "runner",
      current: 0.004,
    });
  });
});
