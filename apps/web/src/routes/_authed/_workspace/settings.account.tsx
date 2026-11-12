import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";
import type { ReactNode } from "react";
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
import { signOut } from "@/lib/session";

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
              <Row label="Joined">{new Date(user.createdAt).toLocaleDateString()}</Row>
            </CardContent>
          )}
        </Card>

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

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex min-w-0 items-center">{children}</span>
    </div>
  );
}
