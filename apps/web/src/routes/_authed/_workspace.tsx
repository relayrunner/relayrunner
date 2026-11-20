import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useLocation,
  useMatchRoute,
} from "@tanstack/react-router";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookOpenIcon,
  BotIcon,
  BrainCircuitIcon,
  Building2Icon,
  ChartColumnIcon,
  ChartColumnStackedIcon,
  ChevronRightIcon,
  CircleUserIcon,
  CloudIcon,
  GaugeIcon,
  HistoryIcon,
  LoaderCircleIcon,
  type LucideIcon,
  MailIcon,
  MenuIcon,
  MessageSquareIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  RadarIcon,
  RadioTowerIcon,
  RouteIcon,
  ServerIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  TagIcon,
  UsersIcon,
  WaypointsIcon,
  WebhookIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { SectionBoundary } from "@/components/error-boundary";
import { FeedbackPopover } from "@/components/feedback-popover";
import { GithubIcon } from "@/components/provider-logos";
import { RUNNER_DEFAULT_RANGE, RUNNER_RANGES, RunnerSheet } from "@/components/runner-sheet";
import { DOCS_URL, SiteFooter } from "@/components/site-footer";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { WorkspaceMark, WorkspaceMenu } from "@/components/workspace-menu";
import { setWorkspace } from "@/lib/analytics";
import { authDisabled } from "@/lib/auth-client";
import { isGitHubOutcome } from "@/lib/github";
import { loadProviderCatalog } from "@/lib/provider-catalog";
import { isOperator } from "@/lib/roles";
import { textParam } from "@/lib/search-params";
import { rangeOrDaysParam, type TimeRange } from "@/lib/time-range";
import { readFlag, saveFlag } from "@/lib/stored-flag";
import { cn } from "@/lib/utils";
import {
  awaitingOwner,
  cachedWorkspace,
  ensureActiveWorkspace,
  watchForOwner,
} from "@/lib/session";
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
  // `runner` opens a runner's panel over any page (components/runner-sheet.tsx), and `runnerRange`
  // is its range when that isn't the default. An older link's `runnerDays=7` reads as `7d`.
  validateSearch: (
    search: Record<string, unknown>,
  ): { runner?: string; runnerRange?: TimeRange } => {
    const runner = textParam(search.runner);
    return {
      runner,
      runnerRange: runner
        ? rangeOrDaysParam(
            search.runnerRange,
            search.runnerDays,
            RUNNER_RANGES,
            RUNNER_DEFAULT_RANGE,
          )
        : undefined,
    };
  },
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

type NavItem = { to: string; label: string; icon: LucideIcon | typeof GithubIcon };

const nav = [
  { to: "/runners", label: "Runners", icon: ServerIcon },
  { to: "/router", label: "Router", icon: RouteIcon },
  { to: "/providers", label: "Providers", icon: CloudIcon },
  { to: "/history", label: "History", icon: HistoryIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
] as const satisfies NavItem[];

const analyticsNav = [
  { to: "/signals", label: "Signals", icon: RadarIcon },
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
  { to: "/admin/ai", label: "AI", icon: BrainCircuitIcon },
] as const satisfies NavItem[];

// Under /settings: the workspace's pages in two groups, then the user's own.
const settingsNav = [
  {
    label: "Workspace",
    items: [
      { to: "/settings/general", label: "General", icon: SlidersHorizontalIcon },
      { to: "/settings/members", label: "Members", icon: UsersIcon },
    ],
  },
  {
    label: "Connections",
    items: [
      { to: "/settings/github", label: "GitHub", icon: GithubIcon },
      { to: "/settings/providers", label: "Providers", icon: CloudIcon },
      { to: "/settings/telemetry", label: "Telemetry", icon: RadioTowerIcon },
    ],
  },
  {
    label: "Account",
    items: [
      { to: "/settings/account", label: "Profile", icon: CircleUserIcon },
      { to: "/settings/notifications", label: "Email", icon: MailIcon },
      { to: "/settings/agents", label: "Agents", icon: BotIcon },
    ],
  },
] as const satisfies { label: string; items: NavItem[] }[];

const navLink =
  "rounded-md px-2.5 py-1.5 text-[15px] text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground";
const navActive = { className: "bg-sidebar-accent text-sidebar-accent-foreground" };
// The sidebar's collapse toggle and the phone's menu button.
const iconButton =
  "flex items-center justify-center rounded-md text-sidebar-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50";

// Whether the sidebar is collapsed to icons, kept per browser. Phones get a top bar with a menu instead.
// The sidebar's children style themselves off its data-collapsed attribute (the sidebar group).
const COLLAPSED_KEY = "relayrunner:sidebar:collapsed";
// Whether an operator has folded the Admin group away, kept per browser.
const ADMIN_COLLAPSED_KEY = "relayrunner:sidebar:admin-collapsed";

function WorkspaceLayout() {
  const { user, current } = Route.useRouteContext();
  const { runner, runnerRange } = Route.useSearch();
  const showAdmin = authDisabled || isOperator(user);
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
      {/* Phones get a top bar with the workspace menu and a button for the page menu. */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-sidebar-border bg-sidebar px-3 py-2 sm:hidden">
        <div className="min-w-0 flex-1">
          <SectionBoundary>
            <WorkspaceMenu workspace={current.workspace} user={user} />
          </SectionBoundary>
        </div>
        <MobileMenu>
          {inSettings ? (
            <SettingsNav workspace={current.workspace} />
          ) : (
            <>
              <PageNav showAdmin={showAdmin} />
              <SidebarFoot inMenu />
            </>
          )}
        </MobileMenu>
      </header>
      <aside
        data-collapsed={collapsed || undefined}
        className="group/sidebar sticky top-0 hidden h-screen flex-col gap-6 overflow-y-auto border-r border-sidebar-border bg-sidebar px-3 py-5 data-[collapsed]:px-2 sm:flex"
      >
        {inSettings ? (
          <SettingsNav workspace={current.workspace} />
        ) : (
          <TooltipProvider>
            <SectionBoundary>
              <WorkspaceMenu workspace={current.workspace} user={user} compact={collapsed} />
            </SectionBoundary>
            <PageNav showAdmin={showAdmin} collapsed={collapsed} />
            <SidebarFoot collapsed={collapsed} />
            <SidebarToggle collapsed={collapsed} onToggle={toggle} />
          </TooltipProvider>
        )}
      </aside>
      {/* On wider screens the footer stays pinned to the bottom of the window, so it doesn't move as
          pages load or rows expand. Phones keep the room for the page. */}
      <main className="flex min-w-0 flex-col">
        <div className="flex-1 p-4 sm:p-8">
          <OwnerPending current={current} />
          <Outlet />
        </div>
        <SiteFooter className="sm:sticky sm:bottom-0 sm:z-10" />
      </main>
      {runner && (
        <SectionBoundary>
          <RunnerSheet
            key={runner}
            runnerKey={runner}
            range={runnerRange ?? RUNNER_DEFAULT_RANGE}
          />
        </SectionBoundary>
      )}
    </div>
  );
}

/** The pages, in a panel from the right. Going to a page closes it. */
function MobileMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pathname = useLocation({ select: (location) => location.pathname });
  useEffect(() => setOpen(false), [pathname]);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger aria-label="Menu" className={cn(iconButton, "size-9 shrink-0")}>
        <MenuIcon aria-hidden className="size-5" />
      </SheetTrigger>
      <SheetContent
        aria-describedby={undefined}
        className="max-w-72 border-sidebar-border bg-sidebar"
      >
        <div className="flex min-h-full flex-col gap-6 px-3 pt-14 pb-5">
          <SheetTitle className="sr-only">Menu</SheetTitle>
          {children}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Every page of the dashboard, in its groups. Admin pages show to operators only. */
function PageNav({ showAdmin, collapsed = false }: { showAdmin: boolean; collapsed?: boolean }) {
  return (
    <>
      <nav className="flex flex-col gap-0.5 px-1 group-data-[collapsed]/sidebar:px-0">
        {nav.map((item) => (
          <NavLink key={item.to} item={item} collapsed={collapsed} />
        ))}
      </nav>
      <nav aria-label="Analytics" className="px-1 group-data-[collapsed]/sidebar:px-0">
        <NavGroup label="Analytics">
          {analyticsNav.map((item) => (
            <NavLink key={item.to} item={item} collapsed={collapsed} />
          ))}
        </NavGroup>
      </nav>
      {showAdmin && <AdminNav collapsed={collapsed} />}
    </>
  );
}

/** The operator pages, under a heading that folds them away. Always open on an admin page. */
function AdminNav({ collapsed }: { collapsed: boolean }) {
  const [foldedPref, setFoldedPref] = useState(() => readFlag(ADMIN_COLLAPSED_KEY));
  const inAdmin = useMatchRoute()({ to: "/admin", fuzzy: true });
  const open = !foldedPref || Boolean(inAdmin);
  const toggle = () => {
    saveFlag(ADMIN_COLLAPSED_KEY, open);
    setFoldedPref(open);
  };
  const label = open ? "Hide admin pages" : "Show admin pages";
  return (
    <nav aria-label="Admin" className="grid gap-0.5 px-1 group-data-[collapsed]/sidebar:px-0">
      <CollapsedTooltip label={label} collapsed={collapsed}>
        <button
          type="button"
          onClick={toggle}
          disabled={Boolean(inAdmin)}
          aria-expanded={open}
          aria-label={collapsed ? label : undefined}
          className="flex items-center gap-1 rounded-md px-2.5 pb-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none group-data-[collapsed]/sidebar:justify-center group-data-[collapsed]/sidebar:px-0"
        >
          <span className="group-data-[collapsed]/sidebar:sr-only">Admin</span>
          <ChevronRightIcon
            aria-hidden
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
          />
        </button>
      </CollapsedTooltip>
      {open && adminNav.map((item) => <NavLink key={item.to} item={item} collapsed={collapsed} />)}
    </nav>
  );
}

// Just after installing the App on an org, GitHub takes a few seconds to say who installed it,
// and until then the installer can't change anything. Say so, and unlock once it arrives.
function OwnerPending({ current }: { current: CurrentWorkspace }) {
  const waiting = awaitingOwner(current);
  useEffect(() => (waiting ? watchForOwner() : undefined), [waiting]);
  if (!waiting) return null;
  return (
    <p
      role="status"
      className="mb-4 flex items-center gap-2 rounded-xl border px-4 py-3 text-sm text-muted-foreground"
    >
      <LoaderCircleIcon aria-hidden className="size-4 shrink-0 animate-spin" />
      Finishing setup with GitHub. You can make changes in a few seconds.
    </p>
  );
}

/** Takes the sidebar's place under /settings: the workspace's pages, then the user's own. */
function SettingsNav({ workspace }: { workspace: { name: string; logo: string | null } }) {
  return (
    <div className="grid gap-5 px-1">
      <Link
        to="/runners"
        className="inline-flex items-center gap-1.5 px-2.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeftIcon aria-hidden className="size-4" />
        Back to dashboard
      </Link>
      <div className="flex min-w-0 items-center gap-2.5 px-2.5">
        <WorkspaceMark name={workspace.name} logo={workspace.logo} className="size-6 text-xs" />
        <span className="truncate text-[15px] font-semibold">{workspace.name}</span>
      </div>
      <nav aria-label="Settings" className="flex flex-col gap-5">
        {settingsNav.map((group) => (
          <NavGroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <NavLink key={item.to} item={item} collapsed={false} />
            ))}
          </NavGroup>
        ))}
      </nav>
    </div>
  );
}

const navItem =
  "flex items-center gap-2.5 group-data-[collapsed]/sidebar:justify-center group-data-[collapsed]/sidebar:px-0";

/** A page in the sidebar: icon and name, or just the icon with the name on hover when collapsed. */
function NavLink({ item, collapsed }: { item: NavItem; collapsed: boolean }) {
  const { to, label, icon: Icon } = item;
  return (
    <CollapsedTooltip label={label} collapsed={collapsed}>
      <Link to={to} className={cn(navLink, navItem)} activeProps={navActive}>
        <Icon aria-hidden className="size-4 shrink-0" />
        <span className="group-data-[collapsed]/sidebar:sr-only">{label}</span>
      </Link>
    </CollapsedTooltip>
  );
}

/** Settings, feedback and the docs, at the foot of the sidebar above the collapse toggle, and of the phone's
 * menu. */
function SidebarFoot({
  collapsed = false,
  inMenu = false,
}: {
  collapsed?: boolean;
  inMenu?: boolean;
}) {
  return (
    <div className="mt-auto grid gap-0.5 px-1 group-data-[collapsed]/sidebar:px-0">
      <NavLink
        item={{ to: "/settings", label: "Settings", icon: SettingsIcon }}
        collapsed={collapsed}
      />
      <CollapsedTooltip label="Feedback" collapsed={collapsed}>
        <FeedbackPopover side={inMenu ? "top" : "right"} align={inMenu ? "start" : "end"}>
          <button type="button" className={cn(navLink, navItem, "w-full")}>
            <MessageSquareIcon aria-hidden className="size-4 shrink-0" />
            <span className="group-data-[collapsed]/sidebar:sr-only">Feedback</span>
          </button>
        </FeedbackPopover>
      </CollapsedTooltip>
      <CollapsedTooltip label="Docs" collapsed={collapsed}>
        <a href={DOCS_URL} className={cn(navLink, navItem)}>
          <BookOpenIcon aria-hidden className="size-4 shrink-0" />
          <span className="group-data-[collapsed]/sidebar:sr-only">Docs</span>
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
      <TooltipContent side="right">{label}</TooltipContent>
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
          className={cn(iconButton, "size-8", collapsed ? "self-center" : "ml-1")}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 content-start gap-0.5">
      <span className="truncate px-2.5 pb-1 text-xs text-muted-foreground group-data-[collapsed]/sidebar:sr-only">
        {label}
      </span>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}
