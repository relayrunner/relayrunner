/**
 * The shared RelayRunner email shell, after ~/Code/uploads' packages/email.
 *
 * Colors track the dashboard's --rr-* tokens (apps/web/src/styles.css); when one moves there, move
 * it here too. Web fonts don't load in most mail clients, so the fallback stacks are the design:
 * sans for headline and body, mono for the wordmark, eyebrow, button label and metadata.
 */

export type RenderedEmail = {
  subject: string;
  text: string;
  html: string;
};

export type EmailCardInput = {
  subject: string;
  /** Inbox preview line, hidden in the body. */
  preheader: string;
  /** Short mono uppercase label above the title, such as "Security". */
  eyebrow: string;
  title: string;
  /** May include pre-escaped markup (from `strong()` or `code()`). Escape user values first. */
  bodyHtml: string;
  text: string;
  cta?: { url: string; label: string };
  footNoteHtml?: string;
};

const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif,'Apple Color Emoji','Segoe UI Emoji'";
const MONO = "ui-monospace,'SF Mono',SFMono-Regular,Menlo,Consolas,monospace";

const BG = "#0b0d10"; // --rr-bg
const PANEL = "#161a20"; // --rr-raised
const LINE = "#272c35"; // --rr-line
const INK = "#e6edf3"; // --rr-ink
const BODY = "#b4bcc6"; // --rr-ink-2
const MUTED = "#8b949e"; // --rr-mute
const GO = "#3fb950"; // --rr-go
const GO_INK = "#03140a"; // --rr-go-ink

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );
}

/** Escaped emphasis for bodyHtml. */
export function strong(value: string): string {
  return `<strong style="color:${INK};font-weight:600;">${escapeHtml(value)}</strong>`;
}

/** Escaped inline code for bodyHtml. */
export function code(value: string): string {
  return `<code style="font-family:${MONO};font-size:13px;color:${INK};">${escapeHtml(value)}</code>`;
}

/** Escaped link for bodyHtml. */
export function link(href: string, label: string): string {
  return `<a href="${escapeHtml(href)}" style="color:${INK};text-decoration:underline;">${escapeHtml(label)}</a>`;
}

/** Dark card shared by every RelayRunner email. */
export function renderEmailCard(input: EmailCardInput): RenderedEmail {
  const cta = input.cta
    ? `<tr><td style="padding-bottom:16px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="background-color:${GO};border-radius:8px;">
              <a href="${escapeHtml(input.cta.url)}" style="display:inline-block;padding:12px 22px;font-family:${MONO};font-size:14px;font-weight:600;color:${GO_INK};text-decoration:none;">${escapeHtml(input.cta.label)}</a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="font-family:${MONO};font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">
          Or paste this link into your browser:<br>
          <a href="${escapeHtml(input.cta.url)}" style="color:${BODY};text-decoration:underline;">${escapeHtml(input.cta.url)}</a>
        </td></tr>`
    : "";

  const foot = input.footNoteHtml
    ? `<tr><td style="padding-top:26px;"><div style="border-top:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr><td style="font-family:${MONO};font-size:12px;line-height:1.7;color:${MUTED};padding-top:18px;">${input.footNoteHtml}</td></tr>`
    : "";

  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"></head>
<body style="margin:0;padding:0;background-color:${BG};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${BG};">
<tr><td align="center" style="padding:40px 16px;">
  <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;width:100%;">
    <tr><td style="padding:0 2px 16px;font-family:${MONO};font-size:14px;font-weight:600;letter-spacing:.01em;color:${INK};">
      <img src="https://relayrunner.app/favicon.png" width="24" height="24" alt="" style="vertical-align:middle;border:0;">&nbsp;relayrunner
    </td></tr>
    <tr><td style="background-color:${PANEL};border:1px solid ${LINE};border-radius:10px;padding:32px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
        <tr><td style="font-family:${MONO};font-size:11px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:${GO};padding-bottom:14px;">${escapeHtml(input.eyebrow)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:22px;line-height:1.35;font-weight:600;letter-spacing:-.01em;color:${INK};padding-bottom:12px;">${escapeHtml(input.title)}</td></tr>
        <tr><td style="font-family:${SANS};font-size:15px;line-height:1.65;color:${BODY};padding-bottom:${input.cta ? 24 : 2}px;">${input.bodyHtml}</td></tr>
        ${cta}
        ${foot}
      </table>
    </td></tr>
    <tr><td align="center" style="font-family:${MONO};font-size:11px;line-height:1.9;color:#6e7681;padding:22px 4px 0;">
      RelayRunner &middot; run your CI jobs on your own machine
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  return { subject: input.subject, text: input.text, html };
}
