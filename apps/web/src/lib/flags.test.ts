import { beforeEach, describe, expect, test, vi } from "vitest";
import { FLAG_KEYS } from "@relayrunner/api-types";

const api = vi.fn();
vi.mock("@/lib/api", () => ({ api: (path: string) => api(path) }));
vi.mock("@/lib/auth-client", () => ({ authDisabled: false }));

const { forgetFlags, loadFlags } = await import("./flags.tsx");

beforeEach(() => {
  forgetFlags();
  api.mockReset();
  vi.useRealTimers();
});

describe("loadFlags", () => {
  test("reads GET /api/flags once per workspace", async () => {
    api.mockResolvedValue({ beta: true });
    expect(await loadFlags("w1")).toEqual({ beta: true });
    expect(await loadFlags("w1")).toEqual({ beta: true });
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith("/flags");
  });

  test("reads them again for another workspace", async () => {
    api.mockResolvedValueOnce({ beta: true }).mockResolvedValueOnce({ beta: false });
    await loadFlags("w1");
    expect(await loadFlags("w2")).toEqual({ beta: false });
  });

  test("answers from the copy and reads again in the background once it's old", async () => {
    vi.useFakeTimers();
    api.mockResolvedValueOnce({ beta: false }).mockResolvedValueOnce({ beta: true });
    await loadFlags("w1");
    vi.advanceTimersByTime(61_000);
    expect(await loadFlags("w1")).toEqual({ beta: false });
    await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(await loadFlags("w1")).toEqual({ beta: true });
  });

  test("a failed read turns every flag off rather than blocking the page", async () => {
    api.mockRejectedValueOnce(new Error("offline"));
    expect(await loadFlags("w1")).toEqual(Object.fromEntries(FLAG_KEYS.map((key) => [key, false])));
    // Not kept: the next navigation asks again.
    api.mockResolvedValueOnce({ beta: true });
    expect(await loadFlags("w1")).toEqual({ beta: true });
  });
});
