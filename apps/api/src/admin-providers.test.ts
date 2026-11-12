import type { CatalogProvider } from "@relayrunner/providers/catalog";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { app } from "./app.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { environmentFor } from "./job-times.ts";
import { loadCatalog } from "./provider-catalog.ts";
import * as testing from "./testing.ts";
import { accessEnv, accessJwt } from "./testing-access.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  const started = await testing.startD1();
  proxy = started.proxy;
  env = { ...started.env, ...accessEnv };
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

async function call(path: string, cookie: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("Cf-Access-Jwt-Assertion", await accessJwt());
  if (init.body) headers.set("content-type", "application/json");
  return app.request(`/api/admin/providers${path}`, { ...init, headers }, env);
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
});
