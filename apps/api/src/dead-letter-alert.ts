/**
 * Alerts on a rising count of webhook dead letters, not on single failures. An hourly cron
 * (wrangler.jsonc `triggers`) counts what was dead-lettered in the past hour; at or over the
 * threshold it logs `webhook dead letters rising` as an error (Workers Logs and Issues) and, when
 * DEAD_LETTER_ALERT_WEBHOOK_URL is set, posts to it. When OPERATOR_ALERT_EMAIL is set, it emails it.
 */
import { countDeadLettersSince } from "./dead-letters.ts";
import { sendEmail } from "./email.ts";
import type { Env } from "./env.ts";

export const DEFAULT_ALERT_THRESHOLD = 10;
const WINDOW_MS = 60 * 60 * 1000;

export function alertThreshold(env: Env) {
  const value = Number(env.DEAD_LETTER_ALERT_THRESHOLD);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ALERT_THRESHOLD;
}

/** Returns how many were dead-lettered in the window and whether that raised an alert. */
export async function checkDeadLetterGrowth(
  env: Env,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<{ count: number; alerted: boolean }> {
  const count = await countDeadLettersSince(env.DEAD_LETTERS, WINDOW_MS, now);
  const threshold = alertThreshold(env);
  if (count < threshold) return { count, alerted: false };
  const text = `RelayRunner: ${count} GitHub webhook deliveries were dead-lettered in the past hour (alert at ${threshold}). Inspect and replay them at /admin/webhooks in the dashboard.`;
  console.error(
    JSON.stringify({ msg: "webhook dead letters rising", count, threshold, windowMinutes: 60 }),
  );
  if (env.DEAD_LETTER_ALERT_WEBHOOK_URL) {
    try {
      // `text` for Slack, `content` for Discord.
      const response = await fetcher(env.DEAD_LETTER_ALERT_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, content: text }),
      });
      if (!response.ok) throw new Error(`alert webhook answered ${response.status}`);
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "webhook dead letter alert not sent",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  if (env.OPERATOR_ALERT_EMAIL) {
    await sendEmail(env, {
      to: env.OPERATOR_ALERT_EMAIL,
      template: "dead-letter-alert",
      context: { count, threshold },
    });
  }
  return { count, alerted: true };
}
