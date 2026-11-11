import { createFileRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/page-header";
import { WorkspaceMark } from "@/components/workspace-menu";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export const Route = createFileRoute("/_authed/_workspace/settings/general")({
  component: GeneralSettingsPage,
});

function GeneralSettingsPage() {
  const { current } = Route.useRouteContext();
  const { workspace, role } = current;

  return (
    <section>
      <PageHeader title="General">
        Your workspace is one GitHub account with the RelayRunner App installed. Its name and logo
        come from GitHub.
      </PageHeader>
      <div className="grid max-w-3xl gap-4">
        <Card className="py-4">
          <CardHeader className="px-4">
            <CardTitle className="flex items-center gap-2.5 text-sm">
              <WorkspaceMark
                name={workspace.name}
                logo={workspace.logo}
                className="size-6 text-xs"
              />
              {workspace.name}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 px-4 text-sm">
            <Row label="Slug">
              <span className="font-mono">{workspace.slug}</span>
            </Row>
            <Row label="Your role">
              <Badge variant="idle" className="capitalize">
                {role}
              </Badge>
            </Row>
            <Row label="Created">{new Date(workspace.createdAt).toLocaleDateString()}</Row>
          </CardContent>
        </Card>
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
