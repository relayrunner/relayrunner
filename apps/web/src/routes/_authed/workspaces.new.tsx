import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Brand } from "@/components/brand";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authed/workspaces/new")({
  component: NewWorkspacePage,
});

function NewWorkspacePage() {
  const { session } = Route.useRouteContext();
  const router = useRouter();

  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Brand />
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Create a workspace</CardTitle>
            <CardDescription>
              A workspace holds your GitHub accounts, your machines and how jobs are routed between
              them. You'll be its owner.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <CreateWorkspaceForm
              onCreated={async () => {
                // Re-run route guards so the new active workspace is loaded.
                await router.invalidate();
                await router.navigate({ to: "/settings/github" });
              }}
            />
          </CardContent>
        </Card>
        {session?.session.activeOrganizationId && (
          <Link to="/runners" className="text-sm text-muted-foreground hover:text-foreground">
            Back to dashboard
          </Link>
        )}
      </div>
    </main>
  );
}
