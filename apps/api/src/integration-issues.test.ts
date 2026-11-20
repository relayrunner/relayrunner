import { eq } from "drizzle-orm";
import { expect, test, vi } from "vitest";
import { createDb, schema } from "./db/index.ts";
import type { Env } from "./env.ts";
import { takeHealthAlerts } from "./health-issues.ts";
import { checkIntegrations } from "./integration-issues.ts";
import * as testing from "./testing.ts";

test("emails a workspace's owners once when its App is suspended, and clears when it's back", async () => {
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
  await suspend(new Date());
  expect(await checkIntegrations(env, db)).toBe(1);
  expect(send).toHaveBeenCalledTimes(1);
  const [message] = send.mock.calls[0]!;
  expect(message.subject).toBe("The RelayRunner app is suspended on GitHub (Acme)");
  expect(message.text).toContain(
    `https://github.com/organizations/acme-health/settings/installations/${workspace.installationId}`,
  );
  expect(await takeHealthAlerts(db)).toMatchObject([
    { key: `integration:app-suspended:${workspace.id}`, state: "failing" },
  ]);

  // Still suspended an hour later: nobody hears again.
  await checkIntegrations(env, db);
  expect(send).toHaveBeenCalledTimes(1);
  expect(await takeHealthAlerts(db)).toEqual([]);

  await suspend(null);
  expect(await checkIntegrations(env, db)).toBe(0);
  expect(await takeHealthAlerts(db)).toMatchObject([{ state: "cleared" }]);
});
