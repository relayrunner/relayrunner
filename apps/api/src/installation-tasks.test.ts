import { describe, expect, test, vi } from "vitest";
import type { Env } from "./env.ts";
import {
  enqueueInstallationTasks,
  handleInstallationTaskBatch,
  INSTALLATION_TASK_QUEUE,
  type InstallationTask,
} from "./installation-tasks.ts";

const sweep = (installationId: number): InstallationTask => ({
  kind: "pick-sweep",
  installationId,
  scopes: [{ kind: "org", org: `org-${installationId}` }],
});

describe("enqueueInstallationTasks", () => {
  test("sends at most 100 messages per batch", async () => {
    const sizes: number[] = [];
    const env = {
      INSTALLATION_TASKS: {
        sendBatch: async (messages: unknown[]) => void sizes.push(messages.length),
      },
    } as unknown as Env;
    await enqueueInstallationTasks(
      env,
      Array.from({ length: 250 }, (_, i) => sweep(i)),
    );
    expect(sizes).toEqual([100, 100, 50]);
  });
});

describe("handleInstallationTaskBatch", () => {
  test("acks a task that logged its own failure, so the next cron run repeats it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      GITHUB_APP_ID: "1",
      GITHUB_APP_PRIVATE_KEY: { get: async () => Promise.reject(new Error("no key")) },
    } as unknown as Env;
    const ack = vi.fn();
    const retry = vi.fn();
    await handleInstallationTaskBatch(
      {
        queue: INSTALLATION_TASK_QUEUE,
        messages: [{ body: sweep(1), attempts: 1, ack, retry }],
      } as unknown as MessageBatch<InstallationTask>,
      env,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
