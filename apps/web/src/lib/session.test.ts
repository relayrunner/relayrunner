import { beforeEach, describe, expect, test, vi } from "vitest";

const readSession = vi.fn();
const getCurrentWorkspace = vi.fn();
const signOutCall = vi.fn();
let apiErrorListener: ((error: unknown, path: string) => void) | undefined;

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`API ${status}`);
  }
}

vi.mock("@/lib/api", () => ({
  ApiError,
  onApiError: (listener: typeof apiErrorListener) => {
    apiErrorListener = listener;
  },
}));
vi.mock("@/lib/auth-client", () => ({
  authClient: { signOut: () => signOutCall() },
  organization: { list: vi.fn(), setActive: vi.fn() },
  readSession: () => readSession(),
}));
vi.mock("@/lib/workspace", () => ({ getCurrentWorkspace: () => getCurrentWorkspace() }));

const session = await import("./session.ts");

const user = (over: Record<string, unknown> = {}) => ({
  session: { id: "s1", activeOrganizationId: "w1", updatedAt: "2026-11-12T00:00:00.000Z" },
  user: { id: "u1", name: "Ada", email: "a@x", termsVersion: "1", privacyVersion: "1", ...over },
});

const workspace = (name = "Acme") => ({ workspace: { id: "w1", name }, role: "owner" });

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.useRealTimers();
  readSession.mockReset();
  getCurrentWorkspace.mockReset();
  session.forgetSession();
});

describe("the session the route guards read", () => {
  test("is read from the API once, then reused on every navigation", async () => {
    readSession.mockResolvedValue(user());
    await session.cachedSession();
    await session.cachedSession();
    await session.cachedSession();
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  test("isn't kept when it couldn't be read, so the next navigation asks again", async () => {
    readSession.mockResolvedValueOnce(undefined).mockResolvedValueOnce(user());
    expect(await session.cachedSession()).toBeNull();
    expect(await session.cachedSession()).toEqual(user());
  });

  test("is checked again in the background once stale, re-running the guards when it changed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    readSession.mockResolvedValue(user());
    await session.cachedSession();

    vi.setSystemTime(Date.now() + session.REVALIDATE_MS);
    readSession.mockResolvedValue(user({ termsVersion: "2" }));
    // Still answers at once with the copy...
    expect((await session.cachedSession())?.user.termsVersion).toBe("1");
    await settle();
    // ...and the guards run again with the new one.
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await session.cachedSession())?.user.termsVersion).toBe("2");
  });

  test("doesn't re-run the guards when only timestamps moved", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    readSession.mockResolvedValue(user());
    await session.cachedSession();
    vi.setSystemTime(Date.now() + session.REVALIDATE_MS);
    readSession.mockResolvedValue(user());
    await session.cachedSession();
    await settle();
    expect(onChange).not.toHaveBeenCalled();
  });

  test("keeps the copy when a background check can't reach the API", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    const signedIn = user();
    readSession.mockResolvedValue(signedIn);
    await session.cachedSession();
    readSession.mockResolvedValue(undefined);
    await session.revalidateSession();
    expect(onChange).not.toHaveBeenCalled();
    expect(await session.cachedSession()).toBe(signedIn);
  });

  test("is checked at once when the API answers 401, and a sign-out re-runs the guards", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    readSession.mockResolvedValue(user());
    await session.cachedSession();
    readSession.mockResolvedValue(null);
    apiErrorListener?.(new ApiError(401), "/machines");
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await session.cachedSession()).toBeNull();
  });

  test("is dropped on sign-out", async () => {
    readSession.mockResolvedValue(user());
    await session.cachedSession();
    await session.signOut();
    readSession.mockResolvedValue(null);
    expect(await session.cachedSession()).toBeNull();
  });
});

describe("the workspace the route guards read", () => {
  test("is read once per workspace, and again for a different one", async () => {
    getCurrentWorkspace.mockResolvedValue(workspace());
    await session.cachedWorkspace("w1");
    await session.cachedWorkspace("w1");
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(1);
    await session.cachedWorkspace("w2");
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(2);
  });

  test("re-runs the guards when the API says it's gone", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    getCurrentWorkspace.mockResolvedValue(workspace());
    await session.cachedWorkspace("w1");
    getCurrentWorkspace.mockRejectedValue(new ApiError(409, "no_active_workspace"));
    apiErrorListener?.(new ApiError(409, "no_active_workspace"), "/machines");
    await settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    // The guard reads it again, which fails and sends them to /welcome.
    await expect(session.cachedWorkspace("w1")).rejects.toThrow();
  });

  test("re-runs the guards when it changed, such as a rename", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    getCurrentWorkspace.mockResolvedValue(workspace());
    await session.cachedWorkspace("w1");
    getCurrentWorkspace.mockResolvedValue(workspace("Acme Inc"));
    await session.revalidateWorkspace();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect((await session.cachedWorkspace("w1")).workspace.name).toBe("Acme Inc");
  });

  test("keeps the copy when a background check fails for another reason", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    getCurrentWorkspace.mockResolvedValue(workspace());
    await session.cachedWorkspace("w1");
    getCurrentWorkspace.mockRejectedValue(new ApiError(500));
    await session.revalidateWorkspace();
    expect(onChange).not.toHaveBeenCalled();
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(2);
  });
});
