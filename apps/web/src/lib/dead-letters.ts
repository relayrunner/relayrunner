import { api } from "@/lib/api";

/** A webhook delivery that reached the DLQ, as GET /api/admin/webhooks/dead-letters lists it. */
export type DeadLetter = {
  id: string;
  deliveryId: string;
  event: string;
  action: string | null;
  repository: string | null;
  installationId: number | null;
  attempts: number;
  deadLetteredAt: string;
  lastError: string | null;
};

export type DeadLetterPage = { deadLetters: DeadLetter[]; nextCursor: string | null };

export type DeadLetterFilter = { event?: string; repository?: string };

const BASE = "/admin/webhooks/dead-letters";

export function listDeadLetters(cursor?: string) {
  return api<DeadLetterPage>(cursor ? `${BASE}?cursor=${encodeURIComponent(cursor)}` : BASE);
}

export function replayDeadLetter(id: string) {
  return api<{ replayed: DeadLetter }>(`${BASE}/${encodeURIComponent(id)}/replay`, {
    method: "POST",
  });
}

export function discardDeadLetter(id: string) {
  return api<{ discarded: string }>(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function replayMatching(filter: DeadLetterFilter) {
  return api<{ replayed: string[]; more: boolean }>(`${BASE}/replay`, {
    method: "POST",
    body: JSON.stringify(filter),
  });
}
