import { afterEach, expect, test, vi } from "vitest";
import type { Env } from "../env.ts";
import { blacksmithSyncer } from "./blacksmith-syncer.ts";

afterEach(() => vi.useRealTimers());

test("a run that never answers fails before the queue's 15-minute limit", async () => {
  vi.useFakeTimers();
  const env = {
    BLACKSMITH_SYNCER: {
      idFromName: () => "id",
      get: () => ({ run: () => new Promise(() => {}) }),
    },
  } as unknown as Env;
  const run = blacksmithSyncer(env, "w1")!({ kind: "usage" } as never);
  const failed = expect(run).rejects.toThrow("didn't answer within 720s");
  await vi.advanceTimersByTimeAsync(12 * 60_000);
  await failed;
});
