import { useRouter } from "@tanstack/react-router";
import { CheckIcon, ChevronsUpDownIcon, LogOutIcon, PlusIcon } from "lucide-react";
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
import { authDisabled, organization, useListOrganizations } from "@/lib/auth-client";
import { signOut } from "@/lib/session";
import { githubInstallHref } from "@/lib/github";
import { cn } from "@/lib/utils";

type MenuUser = { name: string; email: string; image?: string | null } | null;

/**
 * Who you're signed in as, which workspace you're in, and sign out.
 * It opens from the workspace name at the top of the sidebar. Settings has its
 * own link in the sidebar, and the theme lives in Settings › Profile.
 */
export function WorkspaceMenu({
  workspace,
  user,
  compact = false,
}: {
  workspace: { id: string; name: string; logo?: string | null };
  user: MenuUser;
  /** Just the workspace's mark, for the collapsed sidebar. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  // Read when the sidebar renders rather than when the menu opens, so the list is there by the
  // time someone clicks.
  const { data } = useListOrganizations();
  const workspaces = authDisabled ? devWorkspaces : (data ?? []);

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
          compact && "justify-center px-1",
        )}
        aria-label={compact ? `${workspace.name} menu` : undefined}
        disabled={switching}
      >
        <WorkspaceMark name={workspace.name} logo={workspace.logo} className="size-8 text-sm" />
        <span className={cn("grid min-w-0 flex-1 leading-tight", compact && "hidden")}>
          <span className="truncate text-[15px] font-semibold">{workspace.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {user?.name ?? "Dev (auth disabled)"}
          </span>
        </span>
        <ChevronsUpDownIcon
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", compact && "hidden")}
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
        <WorkspaceList workspaces={workspaces} current={workspace.id} onSelect={switchTo} />
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

// The `VITE_AUTH_DISABLED=true` dev preview's switcher: its one workspace and an org with no avatar.
const devWorkspaces = [
  { id: "dev", name: "Dev workspace", logo: "https://github.com/relayrunner.png?size=96" },
  { id: "dev-org", name: "acme-labs", logo: null },
];

/**
 * The user's workspaces, one per GitHub account the App is installed on, plus "Add an
 * organization", which installs the App somewhere new. With one workspace there is nothing to
 * switch to, so only "Add an organization" shows.
 */
function WorkspaceList({
  workspaces,
  current,
  onSelect,
}: {
  workspaces: { id: string; name: string; logo?: string | null }[];
  current: string;
  onSelect: (id: string) => void;
}) {
  return (
    <DropdownMenuGroup>
      {workspaces.length > 1 && (
        <>
          <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
            Workspaces
          </DropdownMenuLabel>
          {workspaces.map((workspace) => (
            <DropdownMenuItem key={workspace.id} onSelect={() => onSelect(workspace.id)}>
              <WorkspaceMark
                name={workspace.name}
                logo={workspace.logo}
                className="size-5 text-[11px]"
              />
              <span className="truncate">{workspace.name}</span>
              {workspace.id === current && (
                <CheckIcon aria-label="Current workspace" className="ml-auto text-go" />
              )}
            </DropdownMenuItem>
          ))}
        </>
      )}
      <DropdownMenuItem asChild>
        {/* A full page load: this leaves the dashboard for GitHub's install page, and the new
              install comes back as its own workspace. */}
        <a href={githubInstallHref()}>
          <PlusIcon />
          Add an organization
        </a>
      </DropdownMenuItem>
    </DropdownMenuGroup>
  );
}

/**
 * The workspace's logo: its GitHub account's avatar (#316), or a square with the first letter, in
 * Signal Green, when there's no avatar or it fails to load.
 */
export function WorkspaceMark({
  name,
  logo,
  className,
}: {
  name: string;
  logo?: string | null;
  className?: string;
}) {
  // The address that failed, so switching to another workspace tries its logo afresh.
  const [failed, setFailed] = useState<string | null>(null);
  if (logo && failed !== logo) {
    return (
      <img
        src={logo}
        alt=""
        onError={() => setFailed(logo)}
        className={cn(
          "shrink-0 rounded-md border border-border bg-secondary object-cover",
          className,
        )}
      />
    );
  }
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
  // A bot or a renamed account can have no picture at its URL: show the initials instead.
  const [broken, setBroken] = useState<string | null>(null);
  return user.image && broken !== user.image ? (
    <img
      src={user.image}
      alt=""
      onError={() => setBroken(user.image ?? null)}
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
