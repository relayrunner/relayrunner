import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { sendEmail, type EmailArgs } from "./email.ts";
import type { Env } from "./env.ts";
import { createDb } from "./db/index.ts";
import { operatorRecipients } from "./notifications.ts";
import * as testing from "./testing.ts";

let proxy: Awaited<ReturnType<typeof testing.startD1>>["proxy"];
let env: Env;

beforeAll(async () => {
  const started = await testing.startD1();
  proxy = started.proxy;
  env = started.env;
}, 60_000);

afterAll(async () => {
  await proxy?.dispose();
});

const list = async (cookie: string) =>
  (
    (await (await testing.call(env, "/me/notifications", cookie)).json()) as {
      notifications: { type: string; enabled: boolean }[];
    }
  ).notifications;

const set = (cookie: string, type: string, enabled: unknown) =>
  testing.call(env, `/me/notifications/${type}`, cookie, { enabled }, "PUT");
const operator = () => testing.signInOperator(env);

describe("/api/me/notifications", () => {
  test("starts with everything on, and operator alerts only for operators", async () => {
    const person = await testing.signIn(env);
    expect(await list(person.cookie)).toEqual([
      { type: "machine-connected", operator: false, enabled: true },
    ]);

    const op = await operator();
    expect((await list(op.cookie)).map((n) => n.type)).toEqual([
      "machine-connected",
      "feedback",
      "dead-letter-alert",
      "price-check",
    ]);
  });

  test("turns an email off and back on", async () => {
    const { cookie } = await testing.signIn(env);
    expect((await set(cookie, "machine-connected", false)).status).toBe(200);
    expect((await list(cookie))[0]!.enabled).toBe(false);
    expect((await set(cookie, "machine-connected", true)).status).toBe(200);
    expect((await list(cookie))[0]!.enabled).toBe(true);
  });

  test("refuses unknown types, operator alerts for others, and bad bodies", async () => {
    const { cookie } = await testing.signIn(env);
    expect((await set(cookie, "machine-taken-over", false)).status).toBe(404);
    expect((await set(cookie, "price-check", false)).status).toBe(404);
    expect((await set(cookie, "machine-connected", "no")).status).toBe(400);
    expect((await set("", "machine-connected", false)).status).toBe(401);
  });

  test("operator alerts go to each operator who leaves them on", async () => {
    await env.DB.prepare("update user set role = null").run();
    const [a, b] = [await operator(), await operator()];
    expect((await operatorRecipients(createDb(env.DB), "price-check")).sort()).toEqual(
      [a.user.email, b.user.email].sort(),
    );
    await set(b.cookie, "price-check", false);
    expect(await operatorRecipients(createDb(env.DB), "price-check")).toEqual([a.user.email]);
    expect((await operatorRecipients(createDb(env.DB), "feedback")).sort()).toEqual(
      [a.user.email, b.user.email].sort(),
    );
  });

  test("skips a user's email once they turn that type off", async () => {
    const { user, cookie } = await testing.signIn(env);
    const send = vi.fn(async () => ({ messageId: "m" }));
    const withEmail = { ...env, EMAIL: { send } as unknown as SendEmail };
    const notice: EmailArgs = {
      to: user.email,
      userId: user.id,
      template: "machine-connected",
      context: { machineName: "mbp", workspaceNames: [], connectedAt: new Date() },
    };
    await sendEmail(withEmail, notice);
    expect(send).toHaveBeenCalledOnce();
    await set(cookie, "machine-connected", false);
    await sendEmail(withEmail, notice);
    expect(send).toHaveBeenCalledOnce();
  });
});
