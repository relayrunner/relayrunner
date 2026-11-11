import { code, escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card.ts";

// Where a connection came from, as the edge reported it. Any part can be unknown.
export interface ConnectionPlace {
  ip: string | null;
  country: string | null;
  city: string | null;
}

const place = (from: ConnectionPlace) =>
  [from.city, from.country].filter(Boolean).join(", ") || from.ip || "an unknown address";

/**
 * Security notice when a machine's live connection is pushed out by a new one from another
 * address. Whoever connects with the machine's token gets its jobs, so the owner hears about it and
 * can revoke the machine if it wasn't them.
 */
export function renderMachineTakenOverEmail(ctx: {
  machineName: string;
  was: ConnectionPlace;
  now: ConnectionPlace;
  at: Date;
  machinesUrl: string;
}): RenderedEmail {
  const when = ctx.at.toUTCString();
  const was = place(ctx.was);
  const now = place(ctx.now);
  const ips = ctx.was.ip && ctx.now.ip ? ` (${ctx.was.ip} → ${ctx.now.ip})` : "";
  return renderEmailCard({
    subject: `${ctx.machineName} connected from another address`,
    preheader: `A new connection from ${now} took over ${ctx.machineName}.`,
    eyebrow: "Security",
    title: "A machine connected from somewhere else",
    bodyHtml: [
      `${strong(ctx.machineName)} was online from ${escapeHtml(was)} when a new connection from ${escapeHtml(now)} took over on ${escapeHtml(when)}${escapeHtml(ips)}.`,
      "<br><br>",
      `If you moved networks or started ${code("relayrunner connect")} somewhere else, you can ignore this. Otherwise someone has a copy of the machine's token and is getting its jobs.`,
    ].join(""),
    text: [
      "A machine connected from somewhere else",
      "",
      `${ctx.machineName} was online from ${was} when a new connection from ${now} took over on ${when}${ips}.`,
      "If you moved networks or started `relayrunner connect` somewhere else, you can ignore this. Otherwise someone has a copy of the machine's token and is getting its jobs.",
      "",
      `Not you? Revoke it, then sign in again on the machine: ${ctx.machinesUrl}`,
    ].join("\n"),
    cta: { url: ctx.machinesUrl, label: "Review machines →" },
    footNoteHtml: `Not you? Revoke the machine, then run ${code("relayrunner connect")} on it to sign in again.`,
  });
}
