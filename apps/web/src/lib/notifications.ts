import { api } from "@/lib/api";

/** An email the signed-in user can turn on or off (GET /api/me/notifications). */
export type NotificationSetting = { type: string; enabled: boolean };

export function listNotifications() {
  return api<{ notifications: NotificationSetting[] }>("/me/notifications");
}

export function setNotification(type: string, enabled: boolean) {
  return api<NotificationSetting>(`/me/notifications/${encodeURIComponent(type)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}
