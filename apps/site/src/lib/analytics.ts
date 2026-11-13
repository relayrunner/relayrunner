/**
 * PostHog on the landing pages and docs. The dashboard (apps/web/src/lib/analytics.ts) sends to the
 * same project, so a visitor who goes on to sign up is one person from first page to first job.
 *
 * Nothing here names a domain, so moving between relayrunner.app and relayrunner.dev needs no
 * change: events go to `/ingest` on whatever host serves the page (worker/index.ts forwards them to
 * PostHog), and the ID cookie is set on that host's root domain (`cross_subdomain_cookie`), which
 * the dashboard's subdomain shares.
 *
 * It only runs on the real site: not in `astro dev`, not on localhost, and not on preview URLs.
 */
import posthog from "posthog-js";

/** The project's public token. It only lets a client send events, so it's fine in the bundle. */
export const POSTHOG_TOKEN = "phc_rKhrH8DbYLh3TKrdXtZjP5agS5a8xmj8tsEn6EJhQpCE";

/** Whether this page should send analytics: a production build, on the live domain. */
export function analyticsEnabled(host: string, prod: boolean): boolean {
  if (!prod) return false;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return false;
  // Preview builds are served from workers.dev.
  return !host.endsWith(".workers.dev");
}

/** The dashboard's link text for a click on a sign-up link, or null for any other link. */
function dashboardLink(target: EventTarget | null): HTMLAnchorElement | null {
  const link = (target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement)) return null;
  const { hostname, pathname } = new URL(link.href);
  // app.<this site's root>, and only its front door: API reference links don't count as sign-ups.
  if (!hostname.startsWith("app.") || pathname.startsWith("/api")) return null;
  return link;
}

export function startAnalytics() {
  if (!analyticsEnabled(location.hostname, import.meta.env.PROD)) return;
  posthog.init(POSTHOG_TOKEN, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    defaults: "2026-08-30",
    // One ID across the site and app.<root>, and an operator's opt-out (set by the dashboard)
    // applies here too.
    cross_subdomain_cookie: true,
    opt_out_capturing_persistence_type: "cookie",
    // Anonymous visitors are counted without a person profile until they sign in.
    person_profiles: "identified_only",
    disable_session_recording: true,
    disable_surveys: true,
  });
  posthog.register({ app: "site" });

  // The conversion: a click through to the dashboard, with which button and where it was.
  document.addEventListener("click", (event) => {
    const link = dashboardLink(event.target);
    if (!link) return;
    posthog.capture("cta_clicked", {
      label: link.textContent?.trim().replace(/\s+/g, " ") ?? "",
      href: link.href,
      section: link.closest("header") ? "header" : (link.closest("section[id]")?.id ?? null),
    });
  });
  // The install command and other copy buttons on the landing pages (main.ts).
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLElement>(
      "[data-copy], [data-copy-inline]",
    );
    if (!button) return;
    posthog.capture("copy_clicked", {
      text: button.dataset.copy ?? button.dataset.copyInline ?? "",
    });
  });
}
