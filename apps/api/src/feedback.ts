// Feedback agents send through the MCP server (apps/agents send_feedback, routes/feedback.ts).
// The text comes from a model that may have pasted logs, configs or tool output into it, so it is
// cleaned and has anything that looks like a credential replaced before it's stored or emailed.

export const FEEDBACK_CATEGORIES = ["bug", "confusing", "feature_request", "other"] as const;
export const FEEDBACK_LIMITS = { summary: 200, details: 4000, tool: 64 } as const;
// Per user, across all their agents: enough to report what went wrong, not enough to flood the inbox.
export const FEEDBACK_RATE = { hour: 10, day: 30 } as const;

const REDACTED = "[redacted]";

// Things that look like credentials. Each match is replaced whole, except where a group names the
// part to keep (`key=` before a value).
const SECRET_PATTERNS: { pattern: RegExp; keep?: number }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  // JWTs, including RelayRunner's own agent access tokens.
  { pattern: /\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g },
  // GitHub tokens and fine-grained PATs.
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g },
  // RelayRunner machine tokens (apps/api/src/machines.ts).
  { pattern: /\brrm_[\w-]{16,}/g },
  // Slack, Stripe/OpenAI/Anthropic-style sk- keys, AWS access key ids, Google API keys.
  { pattern: /\bxox[abposr]-[\w-]{10,}/g },
  { pattern: /\b(?:sk|rk|pk)-(?:[a-z]+-)*[A-Za-z0-9_-]{20,}/g },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: /\bAIza[\w-]{35}\b/g },
  // Credentials in URLs: https://user:pass@host.
  { pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, keep: 1 },
  // Authorization headers and key=value / key: value pairs whose key names a secret.
  { pattern: /(\b(?:Bearer|Basic|token)\s+)[\w.~+/=-]{8,}/gi, keep: 1 },
  {
    pattern:
      /(\b[\w-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|cookie|session)[\w-]*["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    keep: 1,
  },
];

/** `text` with anything that looks like a credential replaced, and how many were. */
export function redactSecrets(text: string) {
  let count = 0;
  for (const { pattern, keep } of SECRET_PATTERNS) {
    text = text.replace(pattern, (...match: string[]) => {
      // Already redacted by an earlier, more specific pattern (`token=ghp_…`).
      if (keep && match[0].slice(match[keep].length).startsWith(REDACTED)) return match[0];
      count++;
      return (keep ? match[keep] : "") + REDACTED;
    });
  }
  return { text, count };
}

// Control characters other than tab and newline, plus zero-width and bidirectional-override
// characters that can hide or reorder text in an inbox or the dashboard.
// oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** Normalized, visible text, trimmed to `max` characters. `singleLine` folds newlines to spaces. */
export function cleanText(value: string, max: number, singleLine = false) {
  let text = value.normalize("NFC").replace(/\r\n?/g, "\n").replace(INVISIBLE, "");
  text = singleLine
    ? text.replace(/\s+/g, " ")
    : text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n");
  text = text.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export interface FeedbackInput {
  category: (typeof FEEDBACK_CATEGORIES)[number];
  summary: string;
  details?: string;
  tool?: string;
}

/** Feedback ready to store: cleaned, size-limited, secrets redacted. */
export function sanitizeFeedback(input: FeedbackInput) {
  const summary = redactSecrets(cleanText(input.summary, FEEDBACK_LIMITS.summary, true));
  const details = input.details
    ? redactSecrets(cleanText(input.details, FEEDBACK_LIMITS.details))
    : { text: "", count: 0 };
  // Tool names are identifiers; anything else in one is dropped.
  const tool = input.tool?.replace(/[^\w.-]/g, "").slice(0, FEEDBACK_LIMITS.tool);
  return {
    category: input.category,
    // Redaction can lengthen a short match ("token abcd1234" → "token [redacted]"); re-trim.
    summary: cleanText(summary.text, FEEDBACK_LIMITS.summary, true),
    details: cleanText(details.text, FEEDBACK_LIMITS.details) || null,
    tool: tool || null,
    redacted: summary.count + details.count,
  };
}
