import { beforeAll, describe, expect, test, vi } from "vitest";
import { emailOperators, sendEmail, type EmailArgs } from "./email.ts";
import type { Env } from "./env.ts";
import { createDb } from "./db/index.ts";
import { operatorRecipients } from "./notifications.ts";
import * as testing from "./testing.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
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
  test("starts with personal emails on, operator copies off, and those only for operators", async () => {
    const person = await testing.signIn(env);
    expect(await list(person.cookie)).toEqual([
      { type: "machine-connected", operator: false, enabled: true },
    ]);

    const op = await operator();
    expect(await list(op.cookie)).toEqual([
      { type: "machine-connected", operator: false, enabled: true },
      { type: "feedback", operator: true, enabled: false },
      { type: "dead-letter-alert", operator: true, enabled: false },
      { type: "price-check", operator: true, enabled: false },
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

  test("operator alerts reach the team inbox, plus operators who opted in", async () => {
    await env.DB.prepare("update user set role = null").run();
    const [a, b] = [await operator(), await operator()];
    expect(await operatorRecipients(createDb(env.DB), "price-check")).toEqual([]);
    await set(b.cookie, "price-check", true);
    expect(await operatorRecipients(createDb(env.DB), "price-check")).toEqual([b.user.email]);
    expect(await operatorRecipients(createDb(env.DB), "feedback")).toEqual([]);

    const send = vi.fn(async () => ({ messageId: "m" }));
    await emailOperators(
      { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com", EMAIL: { send } as unknown as SendEmail },
      { template: "dead-letter-alert", context: { count: 12, threshold: 10 } },
    );
    expect(send.mock.calls.map((call) => (call as unknown[] as [{ to: string }])[0].to)).toEqual([
      "ops@example.com",
    ]);
    await set(a.cookie, "dead-letter-alert", true);
    send.mockClear();
    await emailOperators(
      { ...env, OPERATOR_ALERT_EMAIL: "ops@example.com", EMAIL: { send } as unknown as SendEmail },
      { template: "dead-letter-alert", context: { count: 12, threshold: 10 } },
    );
    expect(send.mock.calls.map((call) => (call as unknown[] as [{ to: string }])[0].to)).toEqual([
      "ops@example.com",
      a.user.email,
    ]);
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
