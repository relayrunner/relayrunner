// Feature flags for the dashboard (docs/feature-flags.md). The API evaluates them with Cloudflare
// Flagship and answers GET /api/flags, since reading Flagship from the browser would need an API
// token in it. The workspace layout loads them with the workspace (routes/_authed/_workspace.tsx),
// so every page can check a flag synchronously:
//
//   const on = useFlag("my-feature");
//   <Flag name="my-feature">…</Flag>
//   beforeLoad: requireFlagRoute("my-feature"),
//
// A flag is only a way to hide UI: the API answers 404 on a flagged feature's own routes too.
import { redirect, useRouteContext } from "@tanstack/react-router";
import type { FlagKey, Flags } from "@relayrunner/api-types";
import { FLAG_KEYS } from "@relayrunner/api-types";
import type { ReactNode } from "react";
import { api } from "@/lib/api";

/** How old a copy can get before the next navigation reads it again, in the background. */
const REVALIDATE_MS = 60_000;

const allFlags = (value: boolean) =>
  Object.fromEntries(FLAG_KEYS.map((key: FlagKey) => [key, value])) as Flags;

// Keyed by the workspace they were read for, so switching workspace never shows the old ones.
let cached: { workspaceId: string; flags: Flags; at: number } | undefined;
let loading: { workspaceId: string; promise: Promise<Flags> } | undefined;

/**
 * The flags for the workspace layout's guard: the copy for `workspaceId` when there is one (read
 * again in the background once it's old), else read from the API. A failed read never blocks a
 * page: every flag reads as off, and the next navigation asks again. The dev preview without
 * sign-in (VITE_AUTH_DISABLED) turns every flag on, to show what's behind them (lib/sample).
 */
export function loadFlags(workspaceId: string): Promise<Flags> {
  if (cached?.workspaceId === workspaceId) {
    if (Date.now() - cached.at >= REVALIDATE_MS) void read(workspaceId);
    return Promise.resolve(cached.flags);
  }
  return read(workspaceId);
}

function read(workspaceId: string): Promise<Flags> {
  if (loading?.workspaceId === workspaceId) return loading.promise;
  const promise = api<Flags>("/flags")
    .then(
      (flags) => {
        cached = { workspaceId, flags, at: Date.now() };
        return flags;
      },
      () => cached?.flags ?? allFlags(false),
    )
    .finally(() => {
      if (loading?.promise === promise) loading = undefined;
    });
  loading = { workspaceId, promise };
  return promise;
}

/** Drops the copy, as on sign-out (lib/session.ts forgetSession). */
export function forgetFlags() {
  cached = undefined;
  loading = undefined;
}

/** Whether `key` is on for the signed-in user in the active workspace. Pages under the workspace layout only. */
export function useFlag(key: FlagKey): boolean {
  return useRouteContext({
    from: "/_authed/_workspace",
    select: (context) => context.flags[key] ?? false,
  });
}

/**
 * Renders `children` only while flag `name` is on, else `fallback` (nothing by default).
 * @public
 */
export function Flag({
  name,
  children,
  fallback = null,
}: {
  name: FlagKey;
  children: ReactNode;
  fallback?: ReactNode;
}) {
  return useFlag(name) ? children : fallback;
}

/**
 * A `beforeLoad` for a page that's only there while flag `key` is on: anyone else lands on
 * Runners, as if the page didn't exist. For routes under the workspace layout.
 */
export function requireFlagRoute(key: FlagKey) {
  return ({ context }: { context: { flags: Flags } }) => {
    if (!context.flags[key]) throw redirect({ to: "/runners" });
  };
}
