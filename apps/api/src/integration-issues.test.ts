import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { takeHealthAlerts } from "./health-issues.ts";
import { checkIntegrations, emailWorkspaceAdmins } from "./integration-issues.ts";
import * as testing from "./testing.ts";

test("emails a workspace's owners when its App is suspended, reminds on schedule, and clears when it's back", async () => {
  const base = await testing.createTestEnv();
  const send = vi.fn(async (_message: { to: string; subject: string; text: string }) => ({
    messageId: "m",
  }));
  const env = { ...base, EMAIL: { send } as unknown as SendEmail } as Env;
  const { cookie } = await testing.signIn(env);
  const { workspace } = await testing.createWorkspace(env, cookie, "Acme", "acme-health");
  const db = createDb(env.DB);
  const installation = schema.githubInstallation;
  const suspend = (at: Date | null) =>
    db
      .update(installation)
      .set({ suspendedAt: at })
      .where(eq(installation.id, workspace.installationId));

  send.mockClear(); // The welcome email.
  const day = (days: number) => new Date(Date.UTC(2026, 10, 20) + days * 86_400_000);
  const sweep = async (at: Date) => {
    const alerts = await takeHealthAlerts(db, at);
    await emailWorkspaceAdmins(env, db, alerts);
    return alerts;
  };
  await suspend(day(0));
  expect(await checkIntegrations(env, db, day(0))).toBe(1);
  expect(send).not.toHaveBeenCalled();
  expect(await sweep(day(0))).toMatchObject([
    { key: `integration:app-suspended:${workspace.id}`, state: "failing" },
  ]);
  expect(send).toHaveBeenCalledTimes(1);
  const [message] = send.mock.calls[0]!;
  expect(message.subject).toBe("The RelayRunner app is suspended on GitHub (Acme)");
  expect(message.text).toContain(
    `https://github.com/organizations/acme-health/settings/installations/${workspace.installationId}`,
  );

  // Still suspended: quiet the next day, a reminder on day 2, the last on day 6, then nothing.
  await checkIntegrations(env, db, day(1));
  expect(await sweep(day(1))).toEqual([]);
  await sweep(day(2));
  await sweep(day(6));
  await sweep(day(30));
  expect(send.mock.calls.map(([message]) => message.subject)).toEqual([
    "The RelayRunner app is suspended on GitHub (Acme)",
    "Reminder: The RelayRunner app is suspended on GitHub (Acme)",
    "Reminder: The RelayRunner app is suspended on GitHub (Acme)",
  ]);

  await suspend(null);
  expect(await checkIntegrations(env, db, day(31))).toBe(0);
  expect(await sweep(day(31))).toMatchObject([{ state: "cleared" }]);
  expect(send).toHaveBeenCalledTimes(3);
});
