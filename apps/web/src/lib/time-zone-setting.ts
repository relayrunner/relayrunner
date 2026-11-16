import { api } from "@/lib/api";

/** Saves the zone the dashboard shows times in for the signed-in user, or null for the browser's. */
export function saveTimeZone(timeZone: string | null) {
  return api<{ timeZone: string | null }>("/me/time-zone", {
    method: "PUT",
    body: JSON.stringify({ timeZone }),
  });
}
