import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { errorText } from "@/lib/api";
import { listNotifications, setNotification, type NotificationSetting } from "@/lib/notifications";

export const Route = createFileRoute("/_authed/_workspace/settings/notifications")({
  loader: () => listNotifications(),
  component: NotificationSettingsPage,
});

// What each email is, in the order the API lists them. Operator alerts only come back for operators.
const EMAILS: Record<string, { label: string; description: string; operator?: boolean }> = {
  "machine-connected": {
    label: "Machine connected",
    description: "When you connect a new machine with the CLI.",
  },
  feedback: {
    label: "Feedback",
    description: "When someone sends feedback from the dashboard or an agent.",
    operator: true,
  },
  "dead-letter-alert": {
    label: "Webhook failures",
    description: "When GitHub webhooks keep failing to process.",
    operator: true,
  },
  "price-check": {
    label: "Price changes",
    description: "When the daily price check finds a new price or can't read a page.",
    operator: true,
  },
};

function NotificationSettingsPage() {
  const { user } = Route.useRouteContext();
  const { notifications } = Route.useLoaderData();
  const known = notifications.filter((n) => EMAILS[n.type]);
  const yours = known.filter((n) => !EMAILS[n.type]!.operator);
  const operator = known.filter((n) => EMAILS[n.type]!.operator);

  return (
    <section>
      <PageHeader title="Email">
        Choose which emails you get{user ? ` at ${user.email}` : ""}. Security emails, like someone
        else taking over your machine's connection, always send.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <EmailCard title="Your account" settings={yours} />
        {operator.length > 0 && (
          <EmailCard
            title="Operator alerts"
            description="Sent to every operator. Turning one off only stops it for you."
            settings={operator}
          />
        )}
      </div>
    </section>
  );
}

function EmailCard({
  title,
  description,
  settings,
}: {
  title: string;
  description?: string;
  settings: NotificationSetting[];
}) {
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-1 px-4">
        {settings.map((setting) => (
          <EmailToggle key={setting.type} setting={setting} />
        ))}
      </CardContent>
    </Card>
  );
}

function EmailToggle({ setting }: { setting: NotificationSetting }) {
  const [enabled, setEnabled] = useState(setting.enabled);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, description } = EMAILS[setting.type]!;

  async function toggle(next: boolean) {
    setEnabled(next);
    setPending(true);
    setError(null);
    try {
      await setNotification(setting.type, next);
    } catch (caught) {
      setEnabled(!next);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <label className="flex cursor-pointer gap-3 rounded-lg py-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--color-go)]"
        checked={enabled}
        disabled={pending}
        onChange={(e) => toggle(e.target.checked)}
      />
      <span className="grid gap-0.5">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">{description}</span>
        {error && <span className="text-destructive">{error}</span>}
      </span>
    </label>
  );
}
