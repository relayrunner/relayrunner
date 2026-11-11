import { Link, Outlet, createFileRoute, redirect, useMatchRoute } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { WorkspaceMenu } from "@/components/workspace-menu";
import { authDisabled } from "@/lib/auth-client";
import { isOperator } from "@/lib/roles";
import { ensureActiveWorkspace, getCurrentWorkspace, type CurrentWorkspace } from "@/lib/workspace";

const devWorkspace: CurrentWorkspace = {
  workspace: {
    id: "dev",
    name: "Dev workspace",
    slug: "dev",
    createdAt: new Date(0).toISOString(),
  },
  role: "owner",
  installations: [],
};

// Pathless layout for pages that act on a workspace. Sends users without one
// to create it, and puts the active workspace in route context.
export const Route = createFileRoute("/_authed/_workspace")({
  beforeLoad: async ({ context }) => {
    if (authDisabled || !context.session) return { current: devWorkspace };
    if (!(await ensureActiveWorkspace(context.session))) {
      throw redirect({ to: "/workspaces/new" });
    }
    try {
      return { current: await getCurrentWorkspace() };
    } catch {
      // The active workspace is gone or no longer ours.
      throw redirect({ to: "/workspaces/new" });
    }
  },
  component: WorkspaceLayout,
});

const nav = [
  { to: "/runners", label: "Runners" },
  { to: "/router", label: "Router" },
  { to: "/activity", label: "Activity" },
  { to: "/runs", label: "Runs" },
  { to: "/job-times", label: "Job times" },
  { to: "/usage", label: "Usage" },
] as const;

// Operators only (user.role = "operator"). Cloudflare Access still gates these pages.
const adminNav = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/workspaces", label: "Workspaces" },
  { to: "/admin/webhooks", label: "Webhooks" },
] as const;

const navLink =
  "rounded-md px-2.5 py-1.5 text-[15px] text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground";
const navActive = { className: "bg-sidebar-accent text-sidebar-accent-foreground" };

function WorkspaceLayout() {
  const { user, current } = Route.useRouteContext();
  const inSettings = useMatchRoute()({ to: "/settings", fuzzy: true });

  return (
    <div className="grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] sm:grid-cols-[240px_1fr] sm:grid-rows-1">
      <aside className="flex flex-col gap-3 border-b border-sidebar-border bg-sidebar px-3 py-4 sm:gap-6 sm:border-r sm:border-b-0 sm:py-5">
        {inSettings ? (
          <SettingsNav workspaceName={current.workspace.name} />
        ) : (
          <>
            <WorkspaceMenu workspace={current.workspace} user={user} />
            <nav className="flex flex-row flex-wrap gap-0.5 px-1 sm:flex-col">
              {nav.map((item) => (
                <Link key={item.to} to={item.to} className={navLink} activeProps={navActive}>
                  {item.label}
                </Link>
              ))}
            </nav>
            {(authDisabled || isOperator(user)) && (
              <nav aria-label="Admin" className="px-1">
                <NavGroup label="Admin">
                  {adminNav.map((item) => (
                    <Link key={item.to} to={item.to} className={navLink} activeProps={navActive}>
                      {item.label}
                    </Link>
                  ))}
                </NavGroup>
              </nav>
            )}
          </>
        )}
      </aside>
      <main className="p-4 sm:p-8">
        <Outlet />
      </main>
    </div>
  );
}

/** Takes the sidebar's place under /settings: workspace pages, then the user's own. */
function SettingsNav({ workspaceName }: { workspaceName: string }) {
  return (
    <div className="grid gap-3 px-1 sm:gap-5">
      <Link
        to="/runners"
        className="inline-flex items-center gap-1.5 px-2.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Back to dashboard
      </Link>
      <nav className="flex flex-row flex-wrap gap-x-4 gap-y-3 sm:flex-col">
        <NavGroup label={workspaceName}>
          <Link to="/settings/general" className={navLink} activeProps={navActive}>
            General
          </Link>
          <Link to="/settings/github" className={navLink} activeProps={navActive}>
            GitHub accounts
          </Link>
          <Link to="/settings/members" className={navLink} activeProps={navActive}>
            Members
          </Link>
        </NavGroup>
        <NavGroup label="Account">
          <Link to="/settings/account" className={navLink} activeProps={navActive}>
            Profile
          </Link>
          <Link to="/settings/agents" className={navLink} activeProps={navActive}>
            Agents
          </Link>
        </NavGroup>
      </nav>
    </div>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="truncate px-2.5 pb-1 text-xs text-muted-foreground">{label}</span>
      <div className="flex flex-row flex-wrap gap-0.5 sm:flex-col">{children}</div>
    </div>
  );
}
