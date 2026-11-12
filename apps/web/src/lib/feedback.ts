import { api } from "@/lib/api";

export const FEEDBACK_EMAIL = "feedback@relayrunner.app";

/** Sends feedback for the team, from the page it was written on (POST /api/feedback). */
export function sendFeedback(message: string, page: string) {
  return api<{ id: string }>("/feedback", {
    method: "POST",
    body: JSON.stringify({ message, page }),
  });
}
