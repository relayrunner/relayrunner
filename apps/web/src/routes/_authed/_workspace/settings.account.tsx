import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/workspace-menu";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorText } from "@/lib/api";
import { authDisabled } from "@/lib/auth-client";
import { forgetSession, signOut } from "@/lib/session";
import {
  browserTimeZone,
  chosenTimeZone,
  formatTime,
  offsetName,
  setTimeZone,
  timeZones,
} from "@/lib/time-zone";
import { saveTimeZone } from "@/lib/time-zone-setting";
import { formatDate } from "@/lib/time-zone";

export const Route = createFileRoute("/_authed/_workspace/settings/account")({
  component: AccountSettingsPage,
});

function AccountSettingsPage() {
  const { user } = Route.useRouteContext();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <section>
      <PageHeader title="Profile">
        You sign in with GitHub, so your name, email and avatar come from your GitHub account.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-3 text-sm">
              {user ? (
                <>
                  <UserAvatar user={user} className="size-10" />
                  <span className="grid leading-tight">
                    <span className="text-base">{user.name}</span>
                    <span className="font-normal text-muted-foreground">{user.email}</span>
                  </span>
                </>
              ) : (
                "Dev (auth disabled)"
              )}
            </CardTitle>
          </CardHeader>
          {user && (
            <CardContent className="grid gap-2 px-4 text-sm">
              <Row label="Signed in">With GitHub</Row>
              <Row label="Joined">{formatDate(user.createdAt)}</Row>
            </CardContent>
          )}
        </Card>

        {(user || authDisabled) && <TimeZoneCard />}

        {user && (
          <Card className="py-4">
            <CardHeader className="px-4">
              <CardTitle className="text-sm">Sign out</CardTitle>
              <CardDescription>Signs you out of the dashboard on this browser.</CardDescription>
              <CardAction>
                <Button variant="outline" size="sm" onClick={handleSignOut}>
                  <LogOutIcon />
                  Sign out
                </Button>
              </CardAction>
            </CardHeader>
          </Card>
        )}
      </div>
    </section>
  );
}

// The picker's value for following the browser, since a Select item can't be empty.
const BROWSER = "browser";

/** Which zone the dashboard shows times and days in. */
function TimeZoneCard() {
  const router = useRouter();
  const [value, setValue] = useState(() => chosenTimeZone() ?? BROWSER);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const browser = browserTimeZone();
  const zones = useMemo(
    () => timeZones().map((zone) => ({ zone, label: `${zoneName(zone)} (${offsetName(zone)})` })),
    [],
  );

  async function choose(next: string) {
    const previous = value;
    const zone = next === BROWSER ? null : next;
    setValue(next);
    setPending(true);
    setError(null);
    try {
      if (!authDisabled) await saveTimeZone(zone);
      setTimeZone(zone);
      // The zone rides the session, so read it again and re-render every page with the new zone.
      forgetSession();
      await router.invalidate();
    } catch (caught) {
      setValue(previous);
      setError(errorText(caught));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Time zone</CardTitle>
        <CardDescription>
          The dashboard shows times and splits days in this zone. It's{" "}
          {formatTime(Date.now(), { hour: "numeric", minute: "2-digit" })} there now.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-2 px-4">
        <Select value={value} onValueChange={choose} disabled={pending}>
          <SelectTrigger aria-label="Time zone" className="w-full max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-80">
            <SelectItem value={BROWSER}>Your browser's ({zoneName(browser)})</SelectItem>
            {zones.map(({ zone, label }) => (
              <SelectItem key={zone} value={zone}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

/** "America/New_York" as "America/New York". */
const zoneName = (zone: string) => zone.replaceAll("_", " ");

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center">{children}</span>
    </div>
  );
}
