// PostHog in the dashboard. The landing site (apps/site/src/lib/analytics.ts) sends to the same
// project and shares the ID cookie on the root domain, so a visitor's site pageviews and their
// signup join up once identify() runs here.
//
// Autocapture is off: the dashboard sends pageviews only. The funnel steps
// (signup, App install, machine connected, first routed job) come from the API, which knows they
// happened even when the tab is closed.
//
// Nothing names a domain: events go to /ingest on this origin (worker/index.ts forwards them) and
// the cookie lands on whatever root domain serves the app. It only runs in production builds on
// the live domain, not on localhost or workers.dev previews. Operators opt out, and the opt-out
// cookie covers the landing site too.
import posthog from "posthog-js";
import type { Session } from "@/lib/auth-client";

/** The project's public token. It only lets a client send events, so it's fine in the bundle. */
export const POSTHOG_TOKEN = "phc_rKhrH8DbYLh3TKrdXtZjP5agS5a8xmj8tsEn6EJhQpCE";

/** Whether this build, on this host, should send analytics. */
export function analyticsEnabled(host: string, prod: boolean): boolean {
  if (!prod) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  return !host.endsWith(".workers.dev");
}

let started = false;
let identified: string | undefined;
let grouped: string | undefined;

export function startAnalytics() {
  if (started || !analyticsEnabled(location.hostname, import.meta.env.PROD)) return;
  started = true;
  posthog.init(POSTHOG_TOKEN, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-08-30",
    autocapture: false,
    cross_subdomain_cookie: true,
    opt_out_capturing_persistence_type: "cookie",
    person_profiles: "identified_only",
    disable_session_recording: true,
    disable_surveys: true,
  });
  posthog.register({ app: "dashboard" });
}

/**
 * Ties this browser to the signed-in user (once per user, though the guards call it on every
 * navigation). Operators are opted out instead, so our own clicking around stays out of the data.
 */
export function identifyUser(user: Session["user"]) {
  if (!started || identified === user.id) return;
  identified = user.id;
  if (user.role === "operator") {
    posthog.opt_out_capturing();
    return;
  }
  if (posthog.has_opted_out_capturing()) posthog.opt_in_capturing();
  posthog.identify(user.id, { name: user.name });
}

/** Puts the user's events in their active workspace's group, for workspace-level analytics. */
export function setWorkspace(workspace: { id: string; name: string; slug: string }) {
  if (!started || grouped === workspace.id || posthog.has_opted_out_capturing()) return;
  grouped = workspace.id;
  posthog.group("workspace", workspace.id, { name: workspace.name, slug: workspace.slug });
}

/** On sign-out: the next person in this browser starts as a new anonymous visitor. */
export function resetAnalytics() {
  if (!started) return;
  identified = undefined;
  grouped = undefined;
  posthog.reset();
}
