import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LogOutIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
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
import { saveTimeZone, signOut } from "@/lib/session";
import { setTheme, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";
import {
  browserTimeZone,
  chosenTimeZone,
  formatDate,
  formatTime,
  offsetName,
  timeZones,
} from "@/lib/time-zone";

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

        <ThemeCard />

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
      await saveTimeZone(zone);
      // Re-renders every page with the new zone.
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

const THEMES: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** System, light or dark, saved in this browser. */
function ThemeCard() {
  const theme = useTheme();
  return (
    <Card className="py-4">
      <CardHeader className="px-4">
        <CardTitle className="text-sm">Theme</CardTitle>
        <CardDescription>Saved in this browser. System follows your computer.</CardDescription>
        <CardAction>
          <div
            role="radiogroup"
            aria-label="Theme"
            className="flex rounded-md border bg-background p-0.5"
          >
            {THEMES.map(({ value, label, icon: Icon }) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                title={label}
                onClick={() => setTheme(value)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  theme === value && "bg-accent text-foreground",
                )}
              >
                <Icon aria-hidden className="size-4" />
                <span className="max-sm:sr-only">{label}</span>
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>
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
