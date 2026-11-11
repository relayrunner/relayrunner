import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { app } from "./app.ts";
import { createDb } from "./db/index.ts";
import type { Env } from "./env.ts";
import { loadPriceBook } from "./prices.ts";
import type { AdminRate } from "./routes/admin-prices.ts";
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
  return app.request(`/api/admin/prices${path}`, { ...init, headers }, env);
}

async function operator() {
  const signedIn = await testing.signIn(env);
  await env.DB.prepare("update user set role = 'operator' where id = ?")
    .bind(signedIn.user.id)
    .run();
  return signedIn;
}

const add = (cookie: string, body: object) =>
  call("", cookie, { method: "POST", body: JSON.stringify(body) });

async function rateOf(cookie: string, provider: string, rate: string) {
  const body = (await (await call("", cookie)).json()) as { rates: AdminRate[] };
  return body.rates.find((r) => r.provider === provider && r.rate === rate)!;
}

describe("/api/admin/prices", () => {
  test("is for operators only", async () => {
    const regular = await testing.signIn(env);
    expect((await call("", regular.cookie)).status).toBe(403);
    expect((await add(regular.cookie, {})).status).toBe(403);
  });

  test("lists each rate with its base prices", async () => {
    const op = await operator();
    const ubicloud = await rateOf(op.cookie, "ubicloud", "standard");
    expect(ubicloud).toMatchObject({ per: "vcpu", current: 0.000625 });
    expect(ubicloud.rows.map((row) => [row.from, row.id])).toEqual([
      ["2023-01-01", null],
      ["2026-05-01", null],
      ["2026-09-01", null],
    ]);
  });

  test("a recorded price applies to reports at once, and can be removed", async () => {
    const op = await operator();
    const today = new Date().toISOString().slice(0, 10);
    expect(
      (await add(op.cookie, { provider: "depot", rate: "nope", usd: 1, from: today })).status,
    ).toBe(400);
    expect(
      (await add(op.cookie, { provider: "depot", rate: "linux", usd: 2, from: today })).status,
    ).toBe(400);

    const price = { provider: "depot", rate: "linux", usd: 0.002, from: today };
    const res = await add(op.cookie, { ...price, source: "https://depot.dev/pricing" });
    expect(res.status).toBe(201);
    const { price: row } = (await res.json()) as { price: { id: string } };
    expect((await add(op.cookie, price)).status).toBe(409);

    const depot = await rateOf(op.cookie, "depot", "linux");
    expect(depot.current).toBe(0.002);
    expect(depot.rows.at(-1)).toMatchObject({ id: row.id, createdBy: op.user.email });
    const book = await loadPriceBook(createDb(env.DB));
    expect(book.usd("depot", "linux", Date.now())).toBe(0.002);

    expect((await call(`/${row.id}`, op.cookie, { method: "DELETE" })).status).toBe(200);
    expect((await call(`/${row.id}`, op.cookie, { method: "DELETE" })).status).toBe(404);
    expect((await rateOf(op.cookie, "depot", "linux")).current).toBe(0.003);
  });
});
