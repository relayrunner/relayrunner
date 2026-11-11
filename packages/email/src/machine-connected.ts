import { escapeHtml, renderEmailCard, strong, type RenderedEmail } from "./card.ts";

/**
 * Security notice when a machine finishes `relayrunner connect`. A machine token can pick up the
 * CI jobs of every workspace its owner is in, so the person who approved it hears about it, and
 * can revoke it if it wasn't them. `workspaceNames` lists those workspaces; it can be empty for
 * someone who hasn't installed the App anywhere yet.
 */
export function renderMachineConnectedEmail(ctx: {
  machineName: string;
  os?: string | null;
  arch?: string | null;
  workspaceNames: string[];
  connectedAt: Date;
  machinesUrl: string;
}): RenderedEmail {
  const platform = [ctx.os, ctx.arch].filter(Boolean).join(" ");
  const machine = platform ? `${ctx.machineName} (${platform})` : ctx.machineName;
  const when = ctx.connectedAt.toUTCString();
  const names = joinNames(ctx.workspaceNames);
  const reach = names
    ? `It can now run CI jobs in ${names} whenever they are routed to it, and in any workspace you join later.`
    : "It will run CI jobs in your workspaces once you install RelayRunner on a GitHub account.";
  return renderEmailCard({
    subject: names ? `New machine connected to ${names}` : "New machine connected to RelayRunner",
    preheader: names
      ? `${machine} can now run CI jobs in ${names}.`
      : `${machine} was connected to your RelayRunner account.`,
    eyebrow: "Security",
    title: "A machine was connected",
    bodyHtml: [
      `${strong(machine)} was connected with your approval on ${escapeHtml(when)}.`,
      "<br><br>",
      names
        ? `It can now run CI jobs in ${ctx.workspaceNames.map(strong).join(", ")} whenever they are routed to it, and in any workspace you join later.`
        : escapeHtml(reach),
    ].join(""),
    text: [
      "A machine was connected",
      "",
      `${machine} was connected with your approval on ${when}.`,
      reach,
      "",
      `Not you? Revoke it: ${ctx.machinesUrl}`,
    ].join("\n"),
    cta: { url: ctx.machinesUrl, label: "Review machines →" },
    footNoteHtml: "If you didn't run <code>relayrunner connect</code>, revoke this machine now.",
  });
}

// "Acme", "Acme and atticoos", "Acme, Beta and atticoos"; "" for none.
function joinNames(names: string[]) {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
