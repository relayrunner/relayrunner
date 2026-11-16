import { existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { lockConnect } from "./connect-lock.ts";

const home = () => mkdtempSync(join(tmpdir(), "rr-connect-lock-"));

describe("lockConnect", () => {
  test("lets one connect in at a time", () => {
    const dir = home();
    const unlock = lockConnect(dir);
    expect(() => lockConnect(dir)).toThrow(
      expect.objectContaining({
        code: "ALREADY_CONNECTED",
        message: expect.stringContaining(`(process ${process.pid})`),
      }),
    );
    unlock();
    expect(existsSync(join(dir, "connect.lock"))).toBe(false);
    lockConnect(dir)();
  });

  test("takes over a lock left by a connect that's gone", () => {
    const dir = home();
    // Far past any real pid.
    symlinkSync("99999999", join(dir, "connect.lock"));
    const unlock = lockConnect(dir);
    expect(() => lockConnect(dir)).toThrow(expect.objectContaining({ code: "ALREADY_CONNECTED" }));
    unlock();
  });

  test("makes the home directory when it isn't there yet", () => {
    lockConnect(join(home(), "nested", ".relayrunner"))();
  });
});
