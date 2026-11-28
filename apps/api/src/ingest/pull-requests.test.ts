import { beforeAll, describe, expect, test } from "vitest";
import type { WebhookMessage } from "@relayrunner/github-webhooks";
import { createDb, schema } from "../db/index.ts";
import type { Env } from "../env.ts";
import * as testing from "../testing.ts";
import { recordPullRequest } from "./pull-requests.ts";

let env: Env;

beforeAll(async () => {
  env = await testing.createTestEnv();
});

const INSTALLATION = 9200;
const at = (day: number) => `2026-11-${day}T00:00:00.000Z`;

function delivery(
  action: string,
  dates: { mergedAt?: string; closedAt?: string; updatedAt: string },
  installationId = INSTALLATION,
): Extract<WebhookMessage, { event: "pull_request" }> {
  return {
    deliveryId: action,
    action,
    installationId,
    receivedAt: dates.updatedAt,
    event: "pull_request",
    repository: { id: 92_000, fullName: "acme/app" },
    pullRequest: {
      number: 5,
      title: "feat: x",
      body: "",
      headSha: "abc",
      changed: null,
      openedAt: at(20),
      mergedAt: dates.mergedAt ?? null,
      closedAt: dates.closedAt ?? null,
      updatedAt: dates.updatedAt,
    },
  };
}

describe("recordPullRequest", () => {
  test("keeps the newest delivery's dates", async () => {
    const db = createDb(env.DB);
    await db.insert(schema.githubInstallation).values({
      id: INSTALLATION,
      accountId: INSTALLATION,
      accountLogin: "acme",
      accountType: "Organization",
    });

    expect(await recordPullRequest(db, delivery("opened", { updatedAt: at(20) }))).toBe(true);
    const merged = { mergedAt: at(22), closedAt: at(22), updatedAt: at(22) };
    await recordPullRequest(db, delivery("closed", merged));
    // A late delivery from before it merged changes nothing.
    await recordPullRequest(db, delivery("synchronize", { updatedAt: at(21) }));

    const rows = await db.select().from(schema.pullRequest);
    expect(rows).toMatchObject([
      {
        number: 5,
        openedAt: new Date(at(20)),
        mergedAt: new Date(at(22)),
        closedAt: new Date(at(22)),
      },
    ]);
  });

  test("skips installations it doesn't know", async () => {
    const db = createDb(env.DB);
    expect(await recordPullRequest(db, delivery("opened", { updatedAt: at(20) }, 1))).toBe(false);
  });
});
