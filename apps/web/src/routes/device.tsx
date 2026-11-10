import { createFileRoute, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Brand } from "@/components/brand";
import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api";
import { authDisabled, getSession, organization, signIn } from "@/lib/auth-client";
import {
  githubInstallHref,
  githubOutcomes,
  isGitHubOutcome,
  type GitHubOutcome,
} from "@/lib/github";
import {
  approveDevice,
  denyDevice,
  describeDeviceError,
  formatUserCode,
  openDeviceCode,
  type DeviceCodeStatus,
} from "@/lib/machines";
import { shouldOpenInstall } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import {
  claimInstallation,
  createFirstWorkspace,
  ensureActiveWorkspace,
  getCurrentWorkspace,
  getUnclaimedInstallations,
  type CurrentWorkspace,
  type Installation,
  type UnclaimedInstallations,
} from "@/lib/workspace";

// Where `relayrunner connect` sends the browser: /device?user_code=ABCDEFGH&name=<hostname>.
// It doubles as onboarding for someone who has never used RelayRunner, so the CLI's one link
// walks them through every step and back here each time:
//
// 1. Connect GitHub, one click (#221). Signed out, the GitHub step is "Continue with GitHub": it
//    signs in (creating the account) and comes back here. Someone with no workspace gets one made
//    for them, named after their GitHub login. With nothing to choose, the page then sends them
//    straight on to the App's install screen (/api/github/install?next=<this page>). It shows the GitHub step instead when they
//    have an install to add, when GitHub has already reported back (?github=), or when they come
//    back without installing (?install=opened), so cancelling doesn't loop. A non-admin's install
//    only sends a request to the org's owners, so with ?github=requested they may carry on and
//    jobs start once an owner accepts.
// 2. Pick the machine's name and approve. The CLI picks up its machine token on its next poll.
//
// The device code lives 30 minutes (apps/api/src/auth.ts), long enough for all of that.
type DeviceSearch = {
  user_code?: string;
  name?: string;
  github?: GitHubOutcome;
  install?: "opened";
};

type Workspace = { id: string; name: string };

type Loaded =
  | { kind: "enter" }
  // Signed out: the GitHub step signs them in first.
  | { kind: "signin" }
  | { kind: "error"; message: string }
  | { kind: "done"; status: DeviceCodeStatus["status"] }
  | {
      kind: "review";
      userCode: string;
      workspaces: Workspace[];
      // The workspace the machine would join: the session's active one. Null with no workspace.
      current: CurrentWorkspace | null;
      unclaimed: UnclaimedInstallations;
    };

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

// Outside the _authed guard so a signed-out visitor stays here: the GitHub step signs them in.
export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>): DeviceSearch => ({
    user_code: typeof search.user_code === "string" ? search.user_code : undefined,
    name: typeof search.name === "string" ? search.name.slice(0, 64) : undefined,
    github: isGitHubOutcome(search.github) ? search.github : undefined,
    install: search.install === "opened" ? "opened" : undefined,
  }),
  beforeLoad: async () => ({ session: authDisabled ? null : await getSession() }),
  loaderDeps: ({ search }) => ({ userCode: search.user_code }),
  loader: async ({ deps, context }): Promise<Loaded> => {
    if (!deps.userCode) return { kind: "enter" };
    if (authDisabled)
      return {
        kind: "review",
        userCode: deps.userCode,
        workspaces: [devWorkspace.workspace],
        current: devWorkspace,
        unclaimed: { installations: [] },
      };
    if (!context.session) return { kind: "signin" };
    let status: DeviceCodeStatus;
    try {
      status = await openDeviceCode(deps.userCode);
    } catch (error) {
      return { kind: "error", message: describeDeviceError(error) };
    }
    if (status.status !== "pending") return { kind: "done", status: status.status };
    let { data } = await organization.list();
    if (!data?.length && context.session) {
      // A new account: make its first workspace rather than asking. If that fails, the page
      // falls back to the Create a workspace form.
      try {
        await createFirstWorkspace(context.session);
        ({ data } = await organization.list());
      } catch {}
    }
    const workspaces = (data ?? []).map(({ id, name }) => ({ id, name }));
    const review = { kind: "review" as const, userCode: deps.userCode, workspaces };
    if (!workspaces.length || !context.session)
      return { ...review, current: null, unclaimed: { installations: [] } };

    const active = await ensureActiveWorkspace(context.session);
    if (!workspaces.some((workspace) => workspace.id === active))
      await organization.setActive({ organizationId: workspaces[0]!.id });
    const current = await getCurrentWorkspace();
    // Only needed for the Connect GitHub step.
    const unclaimed = current.installations.length
      ? { installations: [] }
      : await getUnclaimedInstallations();
    return { ...review, current, unclaimed };
  },
  component: DevicePage,
});

function DevicePage() {
  const loaded = Route.useLoaderData();
  return (
    <main className="grid min-h-screen place-items-center p-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6">
        <Link to="/" aria-label="relayrunner home" className="rounded-md">
          <Brand />
        </Link>
        {loaded.kind === "enter" && <EnterCode />}
        {loaded.kind === "error" && (
          <Message title="Can't connect this machine" body={loaded.message} />
        )}
        {loaded.kind === "done" && (
          <Message
            title={loaded.status === "approved" ? "Already approved" : "Request denied"}
            body={
              loaded.status === "approved"
                ? "This machine is already approved. Head back to your terminal."
                : "This request was denied. Run `relayrunner connect` again to start over."
            }
          />
        )}
        {loaded.kind === "signin" && (
          <div className="flex w-full flex-col gap-4">
            <Steps current="github" withWorkspace={false} />
            <SignInStep />
          </div>
        )}
        {loaded.kind === "review" && <Onboarding loaded={loaded} />}
      </div>
    </main>
  );
}

// For when the CLI's link was typed by hand without its code.
function EnterCode() {
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (code.trim()) void navigate({ to: "/device", search: { user_code: code.trim() } });
  }
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect a machine</CardTitle>
        <CardDescription>
          Enter the code `relayrunner connect` printed in your terminal.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
          <Input
            autoFocus
            required
            placeholder="ABCD-EFGH"
            className="font-mono uppercase"
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" size="lg" className="w-full font-bold" disabled={!code.trim()}>
            Continue
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

type Step = "workspace" | "github" | "approve";

// The workspace step only shows if making one automatically failed.
const steps: { key: Step; label: string }[] = [
  { key: "workspace", label: "Workspace" },
  { key: "github", label: "GitHub" },
  { key: "approve", label: "Approve" },
];

// Picks the first step that still needs doing.
function Onboarding({ loaded }: { loaded: Extract<Loaded, { kind: "review" }> }) {
  const { github, install } = Route.useSearch();
  const [result, setResult] = useState<{ action: "approved" | "denied"; name: string } | null>(
    null,
  );
  const { current } = loaded;
  // A request to an org's owners counts: nothing more the user can do here, and the machine is
  // ready the moment an owner accepts.
  const githubDone = !!current && (current.installations.length > 0 || github === "requested");
  const step: Step = !current ? "workspace" : !githubDone ? "github" : "approve";
  const openInstall =
    !authDisabled &&
    step === "github" &&
    shouldOpenInstall({
      current,
      unclaimedCount: loaded.unclaimed.installations.length,
      outcome: github,
      opened: install === "opened",
    });

  if (result?.action === "approved")
    return (
      <Message
        title="Machine connected"
        body={`${result.name} is enrolled. Head back to your terminal; it finishes on its own. You can close this tab.`}
      />
    );
  if (result?.action === "denied")
    return <Message title="Request denied" body="Nothing was connected. You can close this tab." />;

  return (
    <div className="flex w-full flex-col gap-4">
      <Steps current={step} withWorkspace={step === "workspace"} />
      {step === "workspace" && <CreateWorkspaceStep />}
      {openInstall && <OpenInstall />}
      {step === "github" && current && !openInstall && (
        <ConnectGitHubStep
          workspaces={loaded.workspaces}
          current={current}
          unclaimed={loaded.unclaimed}
          outcome={github}
        />
      )}
      {step === "approve" && current && (
        <ApproveStep
          userCode={loaded.userCode}
          workspaces={loaded.workspaces}
          current={current}
          outcome={github}
          onDone={setResult}
        />
      )}
    </div>
  );
}

function Steps({ current, withWorkspace }: { current: Step; withWorkspace: boolean }) {
  const shown = withWorkspace ? steps : steps.filter((step) => step.key !== "workspace");
  const at = shown.findIndex((step) => step.key === current);
  return (
    <ol className="flex items-center justify-center gap-2 text-xs" aria-label="Setup steps">
      {shown.map((step, index) => {
        const done = index < at;
        const active = index === at;
        return (
          <li key={step.key} className="flex items-center gap-2">
            {index > 0 && <span aria-hidden className="h-px w-5 bg-border" />}
            <span
              aria-current={active ? "step" : undefined}
              className={cn(
                "flex items-center gap-1.5",
                active ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "grid size-5 place-items-center rounded-full border font-mono text-[11px]",
                  done && "border-go-edge bg-go-soft text-foreground",
                  active && "border-foreground",
                )}
              >
                {done ? <CheckIcon aria-hidden className="size-3" /> : index + 1}
              </span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** This page, as a path to come back to, without a stale ?github= outcome. */
function useReturnPath() {
  const { user_code, name } = Route.useSearch();
  const search = new URLSearchParams();
  if (user_code) search.set("user_code", user_code);
  if (name) search.set("name", name);
  return `/device?${search}`;
}

/**
 * The GitHub step for someone signed out. Signing in with GitHub creates the account if it's new,
 * and coming back here makes the workspace and carries straight on to the App install, so the
 * whole step is this one click.
 */
function SignInStep() {
  const back = useReturnPath();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function continueWithGitHub() {
    setError(null);
    setPending(true);
    const { error } = await signIn.social({ provider: "github", callbackURL: back });
    if (error) {
      setError(error.message ?? "Sign-in failed");
      setPending(false);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect GitHub</CardTitle>
        <CardDescription>Sign in and install the RelayRunner GitHub App.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button
          size="lg"
          className="w-full font-bold"
          disabled={pending}
          onClick={() => void continueWithGitHub()}
        >
          Continue with GitHub
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <p className="text-center text-xs text-muted-foreground">
          By continuing, you agree to the{" "}
          <a className="underline underline-offset-2" href="https://relayrunner.app/terms">
            Terms of Service
          </a>{" "}
          and{" "}
          <a className="underline underline-offset-2" href="https://relayrunner.app/privacy">
            Privacy Policy
          </a>
          .
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Sends the browser to GitHub's App install screen. First it marks this page's history entry
 * ?install=opened, so coming back (cancelling on GitHub, or the back button) shows the GitHub step
 * instead of redirecting again.
 */
function OpenInstall() {
  const back = useReturnPath();
  const href = githubInstallHref(back);
  useEffect(() => {
    const opened = new URL(window.location.href);
    opened.searchParams.set("install", "opened");
    window.history.replaceState(window.history.state, "", opened);
    // The back button can restore this page from the cache, still on this card: reload it so it
    // reads ?install=opened.
    const onShow = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    window.addEventListener("pageshow", onShow);
    window.location.assign(href);
    return () => window.removeEventListener("pageshow", onShow);
  }, [href]);
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Opening GitHub…</CardTitle>
        <CardDescription>
          Install the RelayRunner GitHub App on the account whose jobs should route. GitHub sends
          you back here afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild size="lg" className="w-full font-bold">
          <a href={href}>Continue to GitHub</a>
        </Button>
      </CardContent>
    </Card>
  );
}

function CreateWorkspaceStep() {
  const router = useRouter();
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Create a workspace</CardTitle>
        <CardDescription>
          Your machines and GitHub accounts live in a workspace. Name one to connect this machine
          to. You'll be its owner.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* Creating it makes it active; reloading the page's data moves on to the GitHub step. */}
        <CreateWorkspaceForm onCreated={() => router.invalidate()} />
      </CardContent>
    </Card>
  );
}

function ConnectGitHubStep({
  workspaces,
  current,
  unclaimed,
  outcome,
}: {
  workspaces: Workspace[];
  current: CurrentWorkspace;
  unclaimed: UnclaimedInstallations;
  outcome?: GitHubOutcome;
}) {
  const router = useRouter();
  const back = useReturnPath();
  const [claiming, setClaiming] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function claim(installation: Installation) {
    setClaiming(installation.id);
    setError(null);
    try {
      await claimInstallation(installation.id);
      await router.invalidate();
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : undefined;
      setError(
        code === "installation_in_another_workspace"
          ? `${installation.accountLogin} is already connected to another workspace.`
          : code === "github_reauth"
            ? "Your GitHub sign-in has expired. Sign out and back in, then try again."
            : "Couldn't add that installation. Try again.",
      );
    } finally {
      setClaiming(null);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect GitHub</CardTitle>
        <CardDescription>
          Install the RelayRunner GitHub App on the org or personal account whose jobs{" "}
          {current.workspace.name} should route. GitHub sends you back here afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {workspaces.length > 1 && (
          <WorkspaceSelect
            workspaces={workspaces}
            value={current.workspace.id}
            disabled={claiming !== null}
          />
        )}
        {outcome && outcome !== "connected" && outcome !== "updated" && (
          <p
            role="status"
            className="rounded-md border border-run-edge bg-run/15 px-3 py-2 text-sm"
          >
            {githubOutcomes[outcome].message}
          </p>
        )}
        <Button asChild size="lg" className="w-full font-bold">
          {/* A full page load: this leaves the dashboard for GitHub's install page. */}
          <a href={githubInstallHref(back)}>Install on GitHub</a>
        </Button>
        {unclaimed.installations.length > 0 && (
          <div className="grid gap-2 text-sm">
            <p className="text-muted-foreground">Already installed it? Add it instead:</p>
            <ul className="grid gap-2">
              {unclaimed.installations.map((installation) => (
                <li
                  key={installation.id}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-mono">{installation.accountLogin}</span>
                    <Badge variant="idle">
                      {installation.accountType === "User" ? "Personal" : "Org"}
                    </Badge>
                  </span>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={claiming !== null}
                    onClick={() => void claim(installation)}
                  >
                    {claiming === installation.id ? "Adding…" : "Add"}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ApproveStep({
  userCode,
  workspaces,
  current,
  outcome,
  onDone,
}: {
  userCode: string;
  workspaces: Workspace[];
  current: CurrentWorkspace;
  outcome?: GitHubOutcome;
  onDone: (result: { action: "approved" | "denied"; name: string }) => void;
}) {
  const search = Route.useSearch();
  const [name, setName] = useState(search.name ?? "");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const workspaceId = current.workspace.id;
  const awaitingOwner = current.installations.length === 0;

  async function act(action: "approve" | "deny") {
    setError(null);
    setPending(action);
    try {
      if (action === "approve") await approveDevice({ userCode, workspaceId, name: name.trim() });
      else await denyDevice(userCode);
      onDone({ action: action === "approve" ? "approved" : "denied", name: name.trim() });
    } catch (caught) {
      setError(describeDeviceError(caught));
    } finally {
      setPending(null);
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect a machine</CardTitle>
        <CardDescription>
          Check that this code matches your terminal. Approving lets the machine run jobs for the
          workspace's private repos.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void act("approve");
          }}
        >
          {outcome === "connected" && (
            <p
              role="status"
              className="rounded-md border border-go-edge bg-go-soft px-3 py-2 text-sm"
            >
              GitHub account connected.
            </p>
          )}
          {awaitingOwner && (
            <p
              role="status"
              className="rounded-md border border-run-edge bg-run/15 px-3 py-2 text-sm"
            >
              Waiting on an org owner to accept the GitHub App install. You can approve now; jobs
              start reaching this machine once they do.
            </p>
          )}
          <p className="rounded-md border bg-muted py-3 text-center font-mono text-2xl tracking-widest">
            {formatUserCode(userCode)}
          </p>
          {workspaces.length > 1 && (
            <WorkspaceSelect
              workspaces={workspaces}
              value={workspaceId}
              disabled={pending !== null}
            />
          )}
          <label className="grid gap-1.5 text-sm font-medium">
            Machine name
            <Input
              required
              maxLength={64}
              className="font-mono"
              placeholder="my-laptop"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="flex flex-col gap-2">
            <Button
              type="submit"
              size="lg"
              className="w-full font-bold"
              disabled={pending !== null || !name.trim()}
            >
              {pending === "approve" ? "Approving…" : "Approve"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              disabled={pending !== null}
              onClick={() => void act("deny")}
            >
              {pending === "deny" ? "Denying…" : "Deny"}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}

// The machine joins the session's active workspace, so switching makes it active and re-runs the
// page's checks: the other workspace may still need GitHub connected. The ?github= outcome was
// about the previous workspace, so it goes.
function WorkspaceSelect({
  workspaces,
  value,
  disabled,
}: {
  workspaces: Workspace[];
  value: string;
  disabled: boolean;
}) {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const [switching, setSwitching] = useState(false);

  async function change(id: string) {
    setSwitching(true);
    try {
      await organization.setActive({ organizationId: id });
      await navigate({ search: (prev) => ({ ...prev, github: undefined }), replace: true });
      await router.invalidate();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <label className="grid gap-1.5 text-sm font-medium">
      Workspace
      <select
        className="h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
        value={value}
        disabled={disabled || switching}
        onChange={(event) => void change(event.target.value)}
      >
        {workspaces.map((workspace) => (
          <option key={workspace.id} value={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Message({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{body}</CardDescription>
      </CardHeader>
      {action && <CardContent>{action}</CardContent>}
    </Card>
  );
}
