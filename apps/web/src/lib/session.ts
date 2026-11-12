// The signed-in session and the active workspace, kept in memory for the route guards
// (routes/_authed.tsx and routes/_authed/_workspace.tsx). TanStack Router runs a layout's
// beforeLoad on every navigation and every hover preload, so reading both from the API there put
// two round trips, one after the other, in front of every page.
//
// The API is what actually guards data: every /api call checks the session and the membership on
// the server. So the guards read these copies and check them again in the background (when they
// are older than REVALIDATE_MS, when the tab comes back, and when the API answers 401 or
// `no_active_workspace`). If the answer changed, the router re-runs the guards, which redirect as
// before: to /login when signed out, to /agree for new terms, to /welcome without a workspace.
import { ApiError, onApiError } from "@/lib/api";
import { authClient, organization, readSession, type Session } from "@/lib/auth-client";
import { getCurrentWorkspace, type CurrentWorkspace } from "@/lib/workspace";

/** How old a copy can get before the guards check it again, in the background. */
export const REVALIDATE_MS = 30_000;

type Cached<T> = { value: T; at: number };

let session: Cached<Session | null> | undefined;
let sessionLoad: Promise<Session | null> | undefined;
// Keyed by the workspace id it was read for, so switching workspace never reads the old one.
let workspace: (Cached<CurrentWorkspace> & { id: string }) | undefined;
let workspaceLoad: { id: string; promise: Promise<CurrentWorkspace> } | undefined;

let onChange: () => void = () => undefined;

/** What to do when a background check finds the session or workspace changed: re-run the guards. */
export function setOnSessionChange(listener: () => void) {
  onChange = listener;
}

/** Drops both copies, so the guards read them fresh on the next navigation. */
export function forgetSession() {
  session = undefined;
  sessionLoad = undefined;
  workspace = undefined;
  workspaceLoad = undefined;
}

/** Signs out, and drops the copies so no page can render from them after. */
export async function signOut() {
  forgetSession();
  const result = await authClient.signOut();
  forgetSession();
  return result;
}

const stale = (cached: Cached<unknown>) => Date.now() - cached.at >= REVALIDATE_MS;

/** The session for the guards: the copy when there is one, else read from the API. */
export function cachedSession(): Promise<Session | null> {
  if (session) {
    if (stale(session)) void revalidateSession();
    return Promise.resolve(session.value);
  }
  sessionLoad ??= readSession().then((read) => {
    const value = read ?? null;
    // A read that couldn't tell isn't kept: the next navigation asks again.
    if (read !== undefined) session = { value, at: Date.now() };
    sessionLoad = undefined;
    return value;
  });
  return sessionLoad;
}

/** The active workspace for the guards: the copy when it's for `id`, else read from the API. */
export function cachedWorkspace(id: string): Promise<CurrentWorkspace> {
  if (workspace?.id === id) {
    if (stale(workspace)) void revalidateWorkspace();
    return Promise.resolve(workspace.value);
  }
  if (workspaceLoad?.id !== id) {
    const promise = getCurrentWorkspace().then(
      (value) => {
        workspace = { id, value, at: Date.now() };
        if (workspaceLoad?.promise === promise) workspaceLoad = undefined;
        return value;
      },
      (error: unknown) => {
        if (workspaceLoad?.promise === promise) workspaceLoad = undefined;
        throw error;
      },
    );
    workspaceLoad = { id, promise };
  }
  return workspaceLoad.promise;
}

// What a guard acts on, so a background read that only moved timestamps changes nothing.
function sessionKey(value: Session | null) {
  if (!value) return "";
  const { user } = value;
  return JSON.stringify([
    value.session.id,
    value.session.activeOrganizationId,
    user.id,
    user.name,
    user.email,
    user.image,
    user.role,
    user.termsVersion,
    user.privacyVersion,
  ]);
}

let checkingSession: Promise<void> | undefined;

/** Reads the session again and re-runs the guards if it changed. Keeps the copy when offline. */
export function revalidateSession(): Promise<void> {
  checkingSession ??= readSession()
    .then((read) => {
      if (read === undefined || !session) return;
      const changed = sessionKey(read) !== sessionKey(session.value);
      session = { value: read, at: Date.now() };
      if (changed) {
        workspace = undefined;
        onChange();
      }
    })
    .finally(() => {
      checkingSession = undefined;
    });
  return checkingSession;
}

let checkingWorkspace: Promise<void> | undefined;

/** Reads the workspace again and re-runs the guards if it changed or is gone. */
export function revalidateWorkspace(): Promise<void> {
  const cached = workspace;
  if (!cached) return Promise.resolve();
  checkingWorkspace ??= getCurrentWorkspace()
    .then(
      (value) => {
        if (workspace !== cached) return;
        workspace = { id: cached.id, value, at: Date.now() };
        if (JSON.stringify(value) !== JSON.stringify(cached.value)) onChange();
      },
      (error: unknown) => {
        // Gone or no longer ours: the guard reads it again and sends them to /welcome. Anything
        // else (offline, a 500) keeps the copy.
        if (workspace !== cached) return;
        if (error instanceof ApiError && (error.status === 409 || error.status === 401)) {
          forgetSession();
          onChange();
        }
      },
    )
    .finally(() => {
      checkingWorkspace = undefined;
    });
  return checkingWorkspace;
}

/**
 * Makes sure the session has an active workspace, picking the user's first one if none is set.
 * Returns null when the user has no workspace yet.
 */
export async function ensureActiveWorkspace(current: Session): Promise<string | null> {
  if (current.session.activeOrganizationId) return current.session.activeOrganizationId;
  const { data: workspaces } = await organization.list();
  const first = workspaces?.[0];
  if (!first) return null;
  await organization.setActive({ organizationId: first.id });
  // The copy still has none active.
  forgetSession();
  return first.id;
}

/** Checks both copies again when they're stale. */
function revalidateStale() {
  if (session && stale(session)) void revalidateSession();
  if (workspace && stale(workspace)) void revalidateWorkspace();
}

// Coming back to the tab after a while checks both, so a sign-out elsewhere shows up on return.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") revalidateStale();
  });
}

// The API is the real check. When it says signed out, or that the active workspace is gone, check
// the copies at once instead of waiting for them to go stale.
onApiError((error, path) => {
  if (path === "/workspaces/current") return; // revalidateWorkspace handles its own answer
  if (error.status === 401) void revalidateSession();
  else if (error.code === "no_active_workspace") void revalidateWorkspace();
});
