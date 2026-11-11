import { Link, useRouter } from "@tanstack/react-router";
import {
  CheckIcon,
  ChevronsUpDownIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from "lucide-react";
import { useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authDisabled, organization, signOut, useListOrganizations } from "@/lib/auth-client";
import { setTheme, useTheme, type Theme } from "@/lib/theme";
import { cn } from "@/lib/utils";

type MenuUser = { name: string; email: string; image?: string | null } | null;

/**
 * The one menu for everything that isn't a page about runners: who you're
 * signed in as, which workspace you're in, settings, and sign out. It opens
 * from the workspace name at the top of the sidebar.
 */
export function WorkspaceMenu({
  workspace,
  user,
  compact = false,
}: {
  workspace: { id: string; name: string };
  user: MenuUser;
  /** Just the workspace's mark, for the collapsed sidebar. Phones still get the full trigger. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);

  async function switchTo(id: string) {
    if (id === workspace.id) return;
    setSwitching(true);
    try {
      await organization.setActive({ organizationId: id });
      // Re-run the workspace guard so route context holds the new workspace.
      await router.invalidate();
      await router.navigate({ to: "/runners" });
    } finally {
      setSwitching(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    await router.navigate({ to: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-transparent px-2 py-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[state=open]:border-border data-[state=open]:bg-sidebar-accent sm:w-auto sm:max-w-full",
          compact && "sm:justify-center sm:px-1",
        )}
        aria-label={compact ? `${workspace.name} menu` : undefined}
        disabled={switching}
      >
        <WorkspaceMark name={workspace.name} className="size-8 text-sm" />
        <span className={cn("grid min-w-0 flex-1 leading-tight", compact && "sm:hidden")}>
          <span className="truncate text-[15px] font-semibold">{workspace.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {user?.name ?? "Dev (auth disabled)"}
          </span>
        </span>
        <ChevronsUpDownIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", compact && "sm:hidden")}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {user && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
              <UserAvatar user={user} />
              <span className="grid min-w-0 leading-tight">
                <span className="truncate font-medium">{user.name}</span>
                <span className="truncate text-xs text-muted-foreground">{user.email}</span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <WorkspaceList current={workspace.id} onSelect={switchTo} />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/settings/general">
              <SettingsIcon />
              Workspace settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings/account">
              <UserIcon />
              Account settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <ThemePicker />
        {user && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={handleSignOut}>
              <LogOutIcon />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const themes: { value: Theme; label: string; icon: typeof SunIcon }[] = [
  { value: "system", label: "System", icon: MonitorIcon },
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
];

/** System, light or dark, saved in this browser. Stays open so the change is visible. */
function ThemePicker() {
  const theme = useTheme();
  return (
    <div className="flex items-center justify-between gap-2 px-2 py-1 text-sm">
      <span>Theme</span>
      <div
        role="radiogroup"
        aria-label="Theme"
        className="flex rounded-md border bg-background p-0.5"
      >
        {themes.map(({ value, label, icon: Icon }) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={theme === value}
            aria-label={label}
            title={label}
            onClick={() => setTheme(value)}
            className={cn(
              "grid size-7 place-items-center rounded-[5px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50",
              theme === value && "bg-accent text-foreground",
            )}
          >
            <Icon aria-hidden className="size-4" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The user's workspaces, plus "New workspace". With one workspace there is
 * nothing to switch to, so only "New workspace" shows.
 */
function WorkspaceList({ current, onSelect }: { current: string; onSelect: (id: string) => void }) {
  const { data } = useListOrganizations();
  const workspaces = authDisabled ? [] : (data ?? []);
  return (
    <>
      <DropdownMenuGroup>
        {workspaces.length > 1 && (
          <>
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Workspaces
            </DropdownMenuLabel>
            {workspaces.map((workspace) => (
              <DropdownMenuItem key={workspace.id} onSelect={() => onSelect(workspace.id)}>
                <WorkspaceMark name={workspace.name} className="size-5 text-[11px]" />
                <span className="truncate">{workspace.name}</span>
                {workspace.id === current && (
                  <CheckIcon aria-label="Current workspace" className="ml-auto text-go" />
                )}
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <PlusIcon />
            New workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
    </>
  );
}

/** A square with the workspace's first letter, in Signal Green. */
export function WorkspaceMark({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center rounded-md border border-go-edge bg-go-soft font-bold text-go",
        className,
      )}
    >
      {name.trim().charAt(0).toUpperCase() || "W"}
    </span>
  );
}

/** The user's GitHub avatar, or their initials when there isn't one. */
export function UserAvatar({
  user,
  className,
}: {
  user: { name: string; image?: string | null };
  className?: string;
}) {
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return user.image ? (
    <img
      src={user.image}
      alt=""
      className={cn("size-8 shrink-0 rounded-full border border-border", className)}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-full border border-border bg-secondary text-xs font-semibold",
        className,
      )}
    >
      {initials || "?"}
    </span>
  );
}
