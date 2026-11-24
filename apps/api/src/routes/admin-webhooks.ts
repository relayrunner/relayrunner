/**
 * Operator admin routes for webhook dead letters, behind Cloudflare Access: app.ts runs
 * requireAccess on all of /api/admin (docs/cloudflare-access.md).
 *
 * Previews forward /api/* to this production Worker, so replaying from a preview acts on
 * production. Replay goes back through the main queue and consumer, never around them.
 */
import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import {
  discardDeadLetter,
  listDeadLetters,
  replayDeadLetter,
  type DeadLetter,
  type DeadLetterFilter,
} from "../ingest/dead-letters.ts";
import { who } from "../middleware/admin.ts";
import { AppError } from "@relayrunner/errors";
import { log } from "../log.ts";

// The most a bulk replay sends at once. Fix the cause first, then replay a slice.
export const MAX_BULK_REPLAY = 100;

function filterFrom(input: { event?: unknown; repository?: unknown }): DeadLetterFilter {
  return {
    event: typeof input.event === "string" && input.event ? input.event : undefined,
    repository:
      typeof input.repository === "string" && input.repository ? input.repository : undefined,
  };
}

export const adminWebhookRoutes = new Hono<AppEnv>()
  .get("/dead-letters", async (c) => {
    const page = await listDeadLetters(c.env.DEAD_LETTERS, {
      cursor: c.req.query("cursor"),
      limit: Number(c.req.query("limit")) || undefined,
      filter: filterFrom({ event: c.req.query("event"), repository: c.req.query("repository") }),
    });
    return c.json(page);
  })
  // Bulk replay: everything matching a filter, newest first, up to MAX_BULK_REPLAY. A filter is
  // required, so "replay everything" is never one click.
  .post("/dead-letters/replay", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      event?: unknown;
      repository?: unknown;
    };
    const filter = filterFrom(body);
    if (!filter.event && !filter.repository) {
      throw new AppError("INVALID_REQUEST");
    }
    const matching: DeadLetter[] = [];
    let cursor: string | undefined;
    do {
      const page = await listDeadLetters(c.env.DEAD_LETTERS, { cursor, filter, limit: 200 });
      matching.push(...page.deadLetters);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && matching.length < MAX_BULK_REPLAY);
    const replayed: string[] = [];
    for (const letter of matching.slice(0, MAX_BULK_REPLAY)) {
      if (await replayDeadLetter(c.env.DEAD_LETTERS, c.env.WEBHOOK_QUEUE, letter.id)) {
        replayed.push(letter.id);
      }
    }
    log.info("admin.dead_letters_replayed", "webhook dead letters replayed", {
      accessId: who(c.var.accessIdentity),
      filter,
      count: replayed.length,
    });
    return c.json({ replayed, more: matching.length > MAX_BULK_REPLAY });
  })
  .post("/dead-letters/:id/replay", async (c) => {
    const id = c.req.param("id");
    const letter = await replayDeadLetter(c.env.DEAD_LETTERS, c.env.WEBHOOK_QUEUE, id);
    if (!letter) throw new AppError("NOT_FOUND");
    log.info("admin.dead_letter_replayed", "webhook dead letter replayed", {
      accessId: who(c.var.accessIdentity),
      id,
      deliveryId: letter.deliveryId,
      event: letter.event,
    });
    return c.json({ replayed: letter });
  })
  .delete("/dead-letters/:id", async (c) => {
    const id = c.req.param("id");
    if (!(await discardDeadLetter(c.env.DEAD_LETTERS, id))) {
      throw new AppError("NOT_FOUND");
    }
    log.info("admin.dead_letter_discarded", "webhook dead letter discarded", {
      accessId: who(c.var.accessIdentity),
      id,
    });
    return c.json({ discarded: id });
  });
