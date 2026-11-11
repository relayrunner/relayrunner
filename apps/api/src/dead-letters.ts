/**
 * The webhook dead-letter archive: one R2 object per GitHub delivery that reached the DLQ, so
 * someone can see what failed and replay it (`/api/admin/webhooks/*`, the `/admin/webhooks` page).
 *
 * It lives in R2 (`relayrunner-webhook-dead-letters`), not the API's D1, on purpose: D1 failing is
 * the likeliest reason processing failed, and a dead letter written to D1 would fail with it.
 *
 * Keys are `YYYY/MM/DD/<delivery-id>.json`, dated when the message was dead-lettered. A bucket
 * lifecycle rule deletes objects after 30 days; that is the retention. The list fields ride along
 * as custom metadata, so listing never reads object bodies.
 *
 * `errors/<delivery-id>.json` holds the last processing error of a message on its final retries,
 * written by the main consumer and folded into the dead letter, because a DLQ message doesn't
 * carry why it failed. The lifecycle rule cleans up any left behind.
 */
import type { WebhookMessage } from "@relayrunner/github-webhooks";

export const RETENTION_DAYS = 30;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;
// Custom metadata is capped at 2 KB per object; the full error is in the body.
const METADATA_ERROR_CHARS = 300;

export interface DeadLetter {
  // `<YYYY-MM-DD>_<delivery-id>`: names the object without a slash, so it fits in a URL segment.
  id: string;
  deliveryId: string;
  event: string;
  action: string | null;
  repository: string | null;
  installationId: number | null;
  attempts: number;
  deadLetteredAt: string;
  lastError: string | null;
}

export interface DeadLetterRecord extends DeadLetter {
  message: WebhookMessage;
}

export interface LastError {
  error: string;
  attempts: number;
  at: string;
}

const ID = /^(\d{4})-(\d{2})-(\d{2})_([A-Za-z0-9-]{1,100})$/;

export function idToKey(id: string): string | null {
  const match = ID.exec(id);
  if (!match) return null;
  const [, year, month, day, deliveryId] = match;
  return `${year}/${month}/${day}/${deliveryId}.json`;
}

function keyToId(key: string): string {
  const [year, month, day, file] = key.split("/");
  return `${year}-${month}-${day}_${file!.replace(/\.json$/, "")}`;
}

function dayPrefix(date: Date) {
  return date.toISOString().slice(0, 10).replaceAll("-", "/") + "/";
}

function errorKey(deliveryId: string) {
  return `errors/${safeDeliveryId(deliveryId)}.json`;
}

function repositoryOf(message: WebhookMessage): string | null {
  return "repository" in message ? message.repository.fullName : null;
}

// GitHub delivery IDs are GUIDs. Anything else is flattened, so a crafted ID can't leave its day
// prefix or break the URL-safe id.
function safeDeliveryId(deliveryId: string) {
  return deliveryId.replace(/[^A-Za-z0-9-]/g, "-").slice(0, 100) || "unknown";
}

/** Remember why a message failed, so its dead letter can say. Best effort: never throws. */
export async function recordLastError(
  bucket: R2Bucket,
  deliveryId: string,
  lastError: LastError,
): Promise<void> {
  try {
    await bucket.put(errorKey(deliveryId), JSON.stringify(lastError), {
      httpMetadata: { contentType: "application/json" },
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        msg: "webhook last error not recorded",
        deliveryId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** Write one dead letter. Throws if the write fails, so the caller leaves the message unacked. */
export async function archiveDeadLetter(
  bucket: R2Bucket,
  message: WebhookMessage,
  attempts: number,
  now = new Date(),
): Promise<DeadLetter> {
  // Reading the last error is best effort: a dead letter without one beats none at all.
  let lastError: LastError | null = null;
  try {
    const object = await bucket.get(errorKey(message.deliveryId));
    if (object) lastError = await object.json<LastError>();
  } catch {
    lastError = null;
  }
  const key = `${dayPrefix(now)}${safeDeliveryId(message.deliveryId)}.json`;
  const record: DeadLetterRecord = {
    id: keyToId(key),
    deliveryId: message.deliveryId,
    event: message.event,
    action: message.action,
    repository: repositoryOf(message),
    installationId: message.installationId,
    attempts,
    deadLetteredAt: now.toISOString(),
    lastError: lastError?.error ?? null,
    message,
  };
  await bucket.put(key, JSON.stringify(record), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      deliveryId: record.deliveryId,
      event: record.event,
      action: record.action ?? "",
      repository: record.repository ?? "",
      installationId: record.installationId === null ? "" : String(record.installationId),
      attempts: String(attempts),
      deadLetteredAt: record.deadLetteredAt,
      lastError: (record.lastError ?? "").slice(0, METADATA_ERROR_CHARS),
    },
  });
  if (lastError) await bucket.delete(errorKey(message.deliveryId)).catch(() => undefined);
  const { message: _, ...summary } = record;
  return summary;
}

function fromObject(object: R2Object): DeadLetter {
  const meta = object.customMetadata ?? {};
  return {
    id: keyToId(object.key),
    deliveryId: meta.deliveryId ?? keyToId(object.key).split("_")[1]!,
    event: meta.event ?? "unknown",
    action: meta.action || null,
    repository: meta.repository || null,
    installationId: meta.installationId ? Number(meta.installationId) : null,
    attempts: Number(meta.attempts ?? 0),
    deadLetteredAt: meta.deadLetteredAt ?? object.uploaded.toISOString(),
    lastError: meta.lastError || null,
  };
}

async function listDay(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, include: ["customMetadata"] });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

export interface DeadLetterFilter {
  event?: string;
  repository?: string;
}

export interface DeadLetterPage {
  deadLetters: DeadLetter[];
  // The day (YYYY-MM-DD) the next page starts from, or null when there are no older days.
  nextCursor: string | null;
}

function matches(letter: DeadLetter, filter: DeadLetterFilter) {
  if (filter.event && letter.event !== filter.event) return false;
  if (filter.repository && letter.repository?.toLowerCase() !== filter.repository.toLowerCase())
    return false;
  return true;
}

/**
 * Dead letters, newest first. R2 lists keys in ascending order, so this walks back one day prefix
 * at a time from `cursor` (today by default), sorting each day by time. A page holds whole days,
 * so it can run past `limit`; `nextCursor` is the day before the last one read.
 */
export async function listDeadLetters(
  bucket: R2Bucket,
  {
    cursor,
    limit = DEFAULT_PAGE_SIZE,
    filter = {},
    now = new Date(),
  }: { cursor?: string; limit?: number; filter?: DeadLetterFilter; now?: Date } = {},
): Promise<DeadLetterPage> {
  const size = Math.min(Math.max(1, limit), MAX_PAGE_SIZE);
  const today = startOfDay(now);
  const oldest = today - RETENTION_DAYS * DAY_MS;
  let day =
    cursor && /^\d{4}-\d{2}-\d{2}$/.test(cursor) ? Date.parse(`${cursor}T00:00:00Z`) : today;
  if (Number.isNaN(day) || day > today) day = today;
  const deadLetters: DeadLetter[] = [];
  while (day >= oldest && deadLetters.length < size) {
    const letters = (await listDay(bucket, dayPrefix(new Date(day))))
      .map(fromObject)
      .filter((letter) => matches(letter, filter))
      .sort((a, b) => b.deadLetteredAt.localeCompare(a.deadLetteredAt));
    deadLetters.push(...letters);
    day -= DAY_MS;
  }
  return {
    deadLetters,
    nextCursor: day >= oldest ? new Date(day).toISOString().slice(0, 10) : null,
  };
}

export async function getDeadLetter(
  bucket: R2Bucket,
  id: string,
): Promise<DeadLetterRecord | null> {
  const key = idToKey(id);
  if (!key) return null;
  const object = await bucket.get(key);
  return object ? object.json<DeadLetterRecord>() : null;
}

export async function discardDeadLetter(bucket: R2Bucket, id: string): Promise<boolean> {
  const key = idToKey(id);
  if (!key || !(await bucket.head(key))) return false;
  await bucket.delete(key);
  return true;
}

/**
 * Send a dead letter's original message back through the main queue, then delete it. The message
 * keeps its delivery ID, so the consumer's idempotency holds. If the delete fails after the send,
 * the next replay repeats a delivery the consumer already handles idempotently.
 */
export async function replayDeadLetter(
  bucket: R2Bucket,
  queue: Queue<WebhookMessage>,
  id: string,
): Promise<DeadLetter | null> {
  const record = await getDeadLetter(bucket, id);
  if (!record) return null;
  await queue.send(record.message, { contentType: "json" });
  await bucket.delete(idToKey(id)!);
  const { message: _, ...summary } = record;
  return summary;
}

/** How many messages were dead-lettered in the `windowMs` before `now`. */
export async function countDeadLettersSince(
  bucket: R2Bucket,
  windowMs: number,
  now = new Date(),
): Promise<number> {
  const since = now.getTime() - windowMs;
  let count = 0;
  for (let day = startOfDay(now); day + DAY_MS > since; day -= DAY_MS) {
    for (const object of await listDay(bucket, dayPrefix(new Date(day)))) {
      if (object.uploaded.getTime() >= since) count++;
    }
  }
  return count;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date) {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
