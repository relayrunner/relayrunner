import { Link, Outlet, createFileRoute, redirect, useMatchRoute } from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  Building2Icon,
  ChartColumnIcon,
  ChartColumnStackedIcon,
  CloudIcon,
  GaugeIcon,
  HistoryIcon,
  type LucideIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RouteIcon,
  ServerIcon,
  TagIcon,
  UsersIcon,
  WaypointsIcon,
  WebhookIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { FeedbackPopover } from "@/components/feedback-popover";
import { DOCS_URL, SiteFooter } from "@/components/site-footer";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceMark, WorkspaceMenu } from "@/components/workspace-menu";
import { setWorkspace } from "@/lib/analytics";
import { authDisabled } from "@/lib/auth-client";
import { isGitHubOutcome } from "@/lib/github";
import { loadProviderCatalog } from "@/lib/provider-catalog";
import { isOperator } from "@/lib/roles";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { cn } from "@/lib/utils";
import { cachedWorkspace, ensureActiveWorkspace } from "@/lib/session";
import type { CurrentWorkspace } from "@/lib/workspace";

const devWorkspace: CurrentWorkspace = {
  workspace: {
    id: "dev",
    name: "Dev workspace",
    slug: "dev",
    logo: "https://github.com/relayrunner.png?size=96",
    createdAt: new Date(0).toISOString(),
  },
  role: "owner",
  installations: [],
};

// Pathless layout for pages that act on a workspace. Sends users without one to /welcome (installing
// the GitHub App is what makes a workspace), and puts the active workspace in route context.
export const Route = createFileRoute("/_authed/_workspace")({
  beforeLoad: async ({ context, location }) => {
    if (authDisabled || !context.session) return { current: devWorkspace };
    const workspaceId = await ensureActiveWorkspace(context.session);
    if (!workspaceId) {
      // Keep GitHub's word on the way, such as an install request waiting on an org owner.
      const { github } = location.search as { github?: unknown };
      throw redirect({ to: "/welcome", search: isGitHubOutcome(github) ? { github } : {} });
    }
    try {
      // Pages name providers synchronously from the catalog, so it's loaded before any renders.
      // Both are read once and kept (lib/session.ts), so later navigations don't wait on them.
      const [current] = await Promise.all([cachedWorkspace(workspaceId), loadProviderCatalog()]);
      setWorkspace(current.workspace);
      return { current };
    } catch {
      // The active workspace is gone or no longer ours.
      throw redirect({ to: "/welcome" });
    }
  },
  // The first page load shows nothing until the guards are done, rather than a page skeleton
  // without the app around it. Later navigations reuse their answer, so only the page is pending.
  pendingMs: Infinity,
  component: WorkspaceLayout,
});

type NavItem = { to: string; label: string; icon: LucideIcon };

const nav = [
  { to: "/runners", label: "Runners", icon: ServerIcon },
  { to: "/router", label: "Router", icon: RouteIcon },
  { to: "/providers", label: "Providers", icon: CloudIcon },
  { to: "/history", label: "History", icon: HistoryIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
] as const satisfies NavItem[];

const analyticsNav = [
  { to: "/performance", label: "Performance", icon: GaugeIcon },
  { to: "/usage", label: "Usage", icon: ChartColumnIcon },
] as const satisfies NavItem[];

// Operators only (user.role = "operator"). Cloudflare Access still gates these pages.
const adminNav = [
  { to: "/admin/jobs", label: "Jobs", icon: ChartColumnStackedIcon },
  { to: "/admin/users", label: "Users", icon: UsersIcon },
  { to: "/admin/workspaces", label: "Workspaces", icon: Building2Icon },
  { to: "/admin/routing", label: "Routing", icon: WaypointsIcon },
  { to: "/admin/webhooks", label: "Webhooks", icon: WebhookIcon },
  { to: "/admin/providers", label: "Providers", icon: CloudIcon },
  { to: "/admin/prices", label: "Prices", icon: TagIcon },
] as const satisfies NavItem[];

const navLink =
  "rounded-md px-2.5 py-1.5 text-[15px] text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground";
const navActive = { className: "bg-sidebar-accent text-sidebar-accent-foreground" };

// Whether the sidebar is collapsed to icons, kept per browser. Phones always get the full top bar.
// The sidebar's children style themselves off its data-collapsed attribute (the sidebar group).
const COLLAPSED_KEY = "relayrunner:sidebar:collapsed";

function WorkspaceLayout() {
  const { user, current } = Route.useRouteContext();
  const inSettings = useMatchRoute()({ to: "/settings", fuzzy: true });
  const [collapsedPref, setCollapsedPref] = useState(() => readFlag(COLLAPSED_KEY));
  // Settings has its own short nav and a way back, so it always shows in full.
  const collapsed = collapsedPref && !inSettings;
  const toggle = () => {
    const next = !collapsedPref;
    saveFlag(COLLAPSED_KEY, next);
    setCollapsedPref(next);
  };

  return (
    <div
      className={cn(
        "grid min-h-screen grid-cols-1 grid-rows-[auto_1fr] sm:grid-rows-1",
        collapsed ? "sm:grid-cols-[60px_1fr]" : "sm:grid-cols-[240px_1fr]",
      )}
    >
      <aside
        data-collapsed={collapsed || undefined}
        className="group/sidebar flex flex-col gap-3 border-b border-sidebar-border bg-sidebar px-3 py-4 sm:sticky sm:top-0 sm:h-screen sm:gap-6 sm:overflow-y-auto sm:border-r sm:border-b-0 sm:py-5 sm:data-[collapsed]:px-2"
      >
        {inSettings ? (
          <SettingsNav workspace={current.workspace} />
        ) : (
          <TooltipProvider>
            <SectionBoundary>
              <WorkspaceMenu workspace={current.workspace} user={user} compact={collapsed} />
            </SectionBoundary>
            <nav className="flex flex-row flex-wrap gap-0.5 px-1 sm:flex-col sm:group-data-[collapsed]/sidebar:px-0">
              {nav.map((item) => (
                <NavLink key={item.to} item={item} collapsed={collapsed} />
              ))}
            </nav>
            <nav aria-label="Analytics" className="px-1 sm:group-data-[collapsed]/sidebar:px-0">
              <NavGroup label="Analytics">
                {analyticsNav.map((item) => (
                  <NavLink key={item.to} item={item} collapsed={collapsed} />
                ))}
              </NavGroup>
            </nav>
            {(authDisabled || isOperator(user)) && (
              <nav aria-label="Admin" className="px-1 sm:group-data-[collapsed]/sidebar:px-0">
                <NavGroup label="Admin">
                  {adminNav.map((item) => (
                    <NavLink key={item.to} item={item} collapsed={collapsed} />
                  ))}
                </NavGroup>
              </nav>
            )}
            <SidebarFoot collapsed={collapsed} />
            <SidebarToggle collapsed={collapsed} onToggle={toggle} />
          </TooltipProvider>
        )}
      </aside>
      {/* The footer stays pinned to the bottom of the window, so it doesn't move as pages load or
          rows expand. */}
      <main className="flex min-w-0 flex-col">
        <div className="flex-1 p-4 sm:p-8">
          <Outlet />
        </div>
        <SiteFooter className="sticky bottom-0 z-10" />
      </main>
    </div>
  );
}

/** Takes the sidebar's place under /settings: workspace pages, then the user's own. */
function SettingsNav({ workspace }: { workspace: { name: string; logo: string | null } }) {
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
        <NavGroup
          label={
            <span className="flex min-w-0 items-center gap-1.5">
              <WorkspaceMark
                name={workspace.name}
                logo={workspace.logo}
                className="size-4 text-[9px]"
              />
              <span className="truncate">{workspace.name}</span>
            </span>
          }
        >
          <Link to="/settings/general" className={navLink} activeProps={navActive}>
            General
          </Link>
          <Link to="/settings/github" className={navLink} activeProps={navActive}>
            GitHub
          </Link>
          <Link to="/settings/members" className={navLink} activeProps={navActive}>
            Members
          </Link>
          <Link to="/settings/providers" className={navLink} activeProps={navActive}>
            Providers
          </Link>
        </NavGroup>
        <NavGroup label="Account">
          <Link to="/settings/account" className={navLink} activeProps={navActive}>
            Profile
          </Link>
          <Link to="/settings/notifications" className={navLink} activeProps={navActive}>
            Email
          </Link>
          <Link to="/settings/agents" className={navLink} activeProps={navActive}>
            Agents
          </Link>
        </NavGroup>
      </nav>
    </div>
  );
}

const navItem =
  "flex items-center gap-2.5 sm:group-data-[collapsed]/sidebar:justify-center sm:group-data-[collapsed]/sidebar:px-0";

/** A page in the sidebar: icon and name, or just the icon with the name on hover when collapsed. */
function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { to, label, icon: Icon } = item;
  return (
    <CollapsedTooltip label={label} collapsed={collapsed}>
      <Link to={to} className={cn(navLink, navItem)} activeProps={navActive}>
        <Icon aria-hidden className="hidden size-4 shrink-0 sm:block" />
        <span className="sm:group-data-[collapsed]/sidebar:sr-only">{label}</span>
      </Link>
    </CollapsedTooltip>
  );
}

/** Feedback and the docs, at the foot of the sidebar above the collapse toggle. Phones get them in
 * the footer. */
function SidebarFoot({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="mt-auto hidden gap-0.5 px-1 sm:grid sm:group-data-[collapsed]/sidebar:px-0">
      <CollapsedTooltip label="Feedback" collapsed={collapsed}>
        <FeedbackPopover side="right" align="end">
          <button type="button" className={cn(navLink, navItem, "w-full")}>
            <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
            <span className="sm:group-data-[collapsed]/sidebar:sr-only">Feedback</span>
          </button>
        </FeedbackPopover>
      </CollapsedTooltip>
      <CollapsedTooltip label="Docs" collapsed={collapsed}>
        <a href={DOCS_URL} className={cn(navLink, navItem)}>
          <BookOpenIcon aria-hidden className="size-4 shrink-0" />
          <span className="sm:group-data-[collapsed]/sidebar:sr-only">Docs</span>
        </a>
      </CollapsedTooltip>
    </div>
  );
}

function CollapsedTooltip({
  label,
  collapsed,
  children,
}: {
  label: string;
  collapsed: boolean;
  children: ReactNode;
}) {
  if (!collapsed) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right" className="max-sm:hidden">
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const Icon = collapsed ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  const label = collapsed ? "Expand sidebar" : "Collapse sidebar";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onToggle}
          aria-label={label}
          aria-expanded={!collapsed}
          className={cn(
            "hidden size-8 items-center justify-center self-start rounded-md text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:flex",
            collapsed ? "self-center" : "ml-1",
          )}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavGroup({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="truncate px-2.5 pb-1 text-xs text-muted-foreground sm:group-data-[collapsed]/sidebar:sr-only">
        {label}
      </span>
      <div className="flex flex-row flex-wrap gap-0.5 sm:flex-col">{children}</div>
    </div>
  );
}
