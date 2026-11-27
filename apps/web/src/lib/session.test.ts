import { parseError } from "@relayrunner/errors";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { CurrentWorkspace } from "@/lib/workspace";

const readSession = vi.fn();
const getCurrentWorkspace = vi.fn();
const signOutCall = vi.fn();
let apiErrorListener: ((error: unknown, path: string) => void) | undefined;

// What the API answers: an error with this status and, when given, this code.
const apiError = (status: number, code?: string) =>
  parseError(code ? { error: { code, message: code } } : null, status);

vi.mock("@/lib/api", () => ({
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
vi.mock("@/lib/analytics", () => ({ resetAnalytics: vi.fn() }));
vi.mock("@/lib/flags", () => ({ forgetFlags: vi.fn() }));

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
    apiErrorListener?.(apiError(401), "/machines");
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
    getCurrentWorkspace.mockRejectedValue(apiError(409, "NO_ACTIVE_WORKSPACE"));
    apiErrorListener?.(apiError(409, "NO_ACTIVE_WORKSPACE"), "/machines");
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
    getCurrentWorkspace.mockRejectedValue(apiError(500));
    await session.revalidateWorkspace();
    expect(onChange).not.toHaveBeenCalled();
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe("waiting for GitHub to name the installer", () => {
  const made = "2026-11-14T12:00:00.000Z";
  const pending = (ownerPending: boolean): CurrentWorkspace => ({
    workspace: { id: "w1", name: "Acme", slug: "acme", logo: null, createdAt: made },
    role: "member",
    ownerPending,
    installations: [],
  });

  test("only while the owner is pending on a freshly made workspace", () => {
    const at = Date.parse(made);
    expect(session.awaitingOwner(pending(true), at + 5_000)).toBe(true);
    expect(session.awaitingOwner(pending(false), at + 5_000)).toBe(false);
    expect(session.awaitingOwner(pending(true), at + session.OWNER_WAIT_MS)).toBe(false);
  });

  test("checks the workspace every few seconds and re-runs the guards once the role changes", async () => {
    const onChange = vi.fn();
    session.setOnSessionChange(onChange);
    getCurrentWorkspace.mockResolvedValue(pending(true));
    await session.cachedWorkspace("w1");

    vi.useFakeTimers();
    const stop = session.watchForOwner();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(2);
    expect(onChange).not.toHaveBeenCalled();

    getCurrentWorkspace.mockResolvedValue({ ...pending(false), role: "owner" });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(await session.cachedWorkspace("w1")).toMatchObject({ role: "owner" });

    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(getCurrentWorkspace).toHaveBeenCalledTimes(3);
  });
});

describe("a link that names its workspace", () => {
  test("switches to it by id or slug, and leaves the active one alone otherwise", async () => {
    const { organization } = await import("@/lib/auth-client");
    const list = vi.mocked(organization.list);
    const setActive = vi.mocked(organization.setActive);
    list.mockResolvedValue({
      data: [
        { id: "w1", slug: "acme" },
        { id: "w2", slug: "studio" },
      ],
    } as never);
    setActive.mockClear();
    const current = user() as never;

    expect(await session.activateNamedWorkspace(current, "Studio")).toBe("w2");
    expect(setActive).toHaveBeenCalledWith({ organizationId: "w2" });
    setActive.mockClear();
    expect(await session.activateNamedWorkspace(current, "w1")).toBe("w1");
    expect(await session.activateNamedWorkspace(current, "someone-elses")).toBeNull();
    expect(setActive).not.toHaveBeenCalled();
  });
});
