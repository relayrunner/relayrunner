import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { CheckIcon } from "lucide-react";
import { useState, type FormEvent, type ReactNode } from "react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { authDisabled, getSession, signIn } from "@/lib/auth-client";
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
  timeAgo,
  type DeviceCodeStatus,
} from "@/lib/machines";
import { describePlace } from "@/lib/device";
import { onboardingStep, shouldOpenInstall } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

// Where `relayrunner connect` sends the browser: /device?user_code=ABCDEFGH&name=<hostname>.
// It doubles as onboarding for someone who has never used RelayRunner, so the CLI's one link
// walks them through every step and back here each time:
//
// 1. Connect GitHub, one click (#221). Signed out, the GitHub step is "Continue with GitHub": one
//    trip to GitHub that installs the App and signs up (/api/github/signup, see
//    apps/api/src/routes/github.ts), coming back with ?github=connected. The install is the
//    workspace (#316): the API makes it and adds them as its owner. "Already have an account?
//    Sign in" only signs in and comes back here.
//    Signed in with no workspace yet, the page's data load sends them straight on to the App's
//    install screen (/api/github/install?next=<this page>) before anything renders. It shows the
//    GitHub step instead when GitHub has already reported back (?github=), or when they come
//    back without installing (?install=opened), so cancelling doesn't loop. A non-admin's install
//    only sends a request to the org's owners, so with ?github=requested they may carry on and
//    jobs start once an owner accepts. Anyone already in a workspace skips this step.
// 2. Pick the machine's name and the workspaces it takes jobs in, and approve. The machine is the
//    user's (#318); workspaces they installed start ticked, ones they only joined through GitHub
//    start unticked (#364), so an org that adds them never gets their machine unless they pick it.
//    The CLI picks up its machine token on its next poll.
//
// The device code lives 15 minutes (apps/api/src/auth.ts): enough for all of that, short enough
// that an approval link someone else started goes stale quickly.
type DeviceSearch = {
  user_code?: string;
  name?: string;
  github?: GitHubOutcome;
  install?: "opened";
};

// `joined`: a workspace the user only joined through GitHub, so it starts unticked.
type Workspace = { id: string; name: string; joined: boolean };

type Loaded =
  | { kind: "enter" }
  // Signed out: the GitHub step signs them in first.
  | { kind: "signin" }
  | { kind: "error"; message: string }
  | { kind: "done"; status: DeviceCodeStatus["status"] }
  | {
      kind: "review";
      userCode: string;
      // When and where the CLI asked for the code (null in dev).
      origin: Pick<DeviceCodeStatus, "requested_at" | "requested_from"> | null;
      // Every workspace the user is in, to pick where the machine takes jobs.
      workspaces: Workspace[];
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
  loaderDeps: ({ search }) => ({
    userCode: search.user_code,
    name: search.name,
    github: search.github,
    install: search.install,
  }),
  loader: async ({ deps, context }): Promise<Loaded> => {
    if (leavingForGitHub) return leaving();
    if (!deps.userCode) return { kind: "enter" };
    if (authDisabled)
      return {
        kind: "review",
        userCode: deps.userCode,
        origin: null,
        workspaces: [
          { id: "dev", name: "relayrunner", joined: false },
          { id: "personal", name: "atticoos", joined: false },
          { id: "acme", name: "acme-labs", joined: true },
        ],
      };
    if (!context.session) return { kind: "signin" };
    let status: DeviceCodeStatus;
    try {
      status = await openDeviceCode(deps.userCode);
    } catch (error) {
      return { kind: "error", message: describeDeviceError(error) };
    }
    if (status.status !== "pending") return { kind: "done", status: status.status };
    const workspaces = (status.workspaces ?? []).map(({ id, name, joined }) => ({
      id,
      name,
      joined,
    }));
    // No workspace yet: installing the App makes one, so go straight to GitHub.
    if (
      shouldOpenInstall({
        hasWorkspace: workspaces.length > 0,
        outcome: deps.github,
        opened: deps.install === "opened",
      })
    )
      return openInstall(returnPath(deps));
    return {
      kind: "review",
      userCode: deps.userCode,
      origin: { requested_at: status.requested_at, requested_from: status.requested_from },
      workspaces,
    };
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
            <Steps current="github" />
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

type Step = "github" | "approve";

const steps: { key: Step; label: string }[] = [
  { key: "github", label: "GitHub" },
  { key: "approve", label: "Approve" },
];

// Picks the first step that still needs doing.
function Onboarding({ loaded }: { loaded: Extract<Loaded, { kind: "review" }> }) {
  const { github } = Route.useSearch();
  const [result, setResult] = useState<{ action: "approved" | "denied"; name: string } | null>(
    null,
  );
  const step = onboardingStep({ hasWorkspace: loaded.workspaces.length > 0, outcome: github });

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
      <Steps current={step} />
      {step === "github" && <ConnectGitHubStep outcome={github} />}
      {step === "approve" && (
        <ApproveStep
          userCode={loaded.userCode}
          origin={loaded.origin}
          workspaces={loaded.workspaces}
          outcome={github}
          onDone={setResult}
        />
      )}
    </div>
  );
}

function Steps({ current }: { current: Step }) {
  const shown = steps;
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
function returnPath({ userCode, name }: { userCode?: string; name?: string }) {
  const search = new URLSearchParams();
  if (userCode) search.set("user_code", userCode);
  if (name) search.set("name", name);
  return `/device?${search}`;
}

function useReturnPath() {
  const { user_code, name } = Route.useSearch();
  return returnPath({ userCode: user_code, name });
}

// Marking the URL makes the router load this page again; while the browser is on its way to
// GitHub, that load waits too, so it can't render the GitHub step in the meantime.
let leavingForGitHub = false;
const leaving = () => new Promise<never>(() => {});

/**
 * Sends the browser to GitHub's App install screen straight from the page's data load, so nothing
 * renders first. It marks this page's history entry ?install=opened, so coming back (cancelling on
 * GitHub, or the back button) shows the GitHub step instead of redirecting again. Never resolves:
 * the page is on its way out.
 */
function openInstall(back: string): Promise<never> {
  leavingForGitHub = true;
  const opened = new URL(window.location.href);
  opened.searchParams.set("install", "opened");
  window.history.replaceState(window.history.state, "", opened);
  // The back button can restore this page from the cache, mid-load: reload it so it reads
  // ?install=opened.
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  window.location.assign(githubInstallHref(back));
  return leaving();
}

/**
 * The GitHub step for someone signed out. "Continue with GitHub" is for someone new: it installs
 * the App and signs up in one trip, and comes back here to approve. "Sign in" is for an existing
 * account: a plain sign-in, after which the page picks up wherever they are.
 */
function SignInStep() {
  const back = useReturnPath();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For someone who already has an account: sign in only, and the page picks up from there.
  async function signInOnly() {
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
        <CardDescription>Sign up and install the RelayRunner GitHub App.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button asChild size="lg" className="w-full font-bold">
          {/* A full page load: one trip to GitHub installs the App and signs up. */}
          <a href={`/api/github/signup?next=${encodeURIComponent(back)}`}>Continue with GitHub</a>
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Already have an account?{" "}
          <button
            type="button"
            className="text-foreground underline-offset-4 hover:underline disabled:opacity-50"
            disabled={pending}
            onClick={() => void signInOnly()}
          >
            Sign in
          </button>
        </p>
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

// No workspace yet. Installing the App on an account makes that account's workspace (#316).
function ConnectGitHubStep({ outcome }: { outcome?: GitHubOutcome }) {
  const back = useReturnPath();
  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle>Connect GitHub</CardTitle>
        <CardDescription>
          Install the RelayRunner GitHub App on the org or personal account whose jobs this machine
          should run. GitHub sends you back here afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
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
      </CardContent>
    </Card>
  );
}

function ApproveStep({
  userCode,
  origin,
  workspaces,
  outcome,
  onDone,
}: {
  userCode: string;
  origin: Extract<Loaded, { kind: "review" }>["origin"];
  workspaces: Workspace[];
  outcome?: GitHubOutcome;
  onDone: (result: { action: "approved" | "denied"; name: string }) => void;
}) {
  const search = Route.useSearch();
  const [name, setName] = useState(search.name ?? "");
  const [pending, setPending] = useState<"approve" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only reachable with no workspace after a request to an org's owners (onboardingStep).
  const awaitingOwner = workspaces.length === 0;
  const [picked, setPicked] = useState(
    () => new Set(workspaces.filter((workspace) => !workspace.joined).map((w) => w.id)),
  );
  // The API needs at least one workspace whenever the user has any.
  const nonePicked = !awaitingOwner && picked.size === 0;
  function toggle(id: string) {
    setPicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function act(action: "approve" | "deny") {
    setError(null);
    setPending(action);
    try {
      if (action === "approve")
        await approveDevice({
          userCode,
          name: name.trim(),
          // Left out with no workspace yet: the API puts it in the first one they install.
          workspaceIds: awaitingOwner ? undefined : [...picked],
        });
      else await denyDevice(userCode);
      onDone({
        action: action === "approve" ? "approved" : "denied",
        name: name.trim(),
      });
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
          Check that this code matches your terminal. Approving lets the machine run your jobs,
          private repos included, in the workspaces you pick.
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
          <RequestOrigin origin={origin} />
          {workspaces.length > 0 && (
            <WorkspacePicker workspaces={workspaces} picked={picked} onToggle={toggle} />
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
              disabled={pending !== null || !name.trim() || nonePicked}
            >
              {pending === "approve" ? "Approving…" : "Approve"}
            </Button>
            {nonePicked && (
              <p className="text-center text-sm text-muted-foreground">
                Pick at least one workspace.
              </p>
            )}
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

// Which workspaces the machine takes jobs in. Ones the user installed start ticked; ones they
// only joined through GitHub start unticked, so an org that invites them never gets their machine
// without them choosing it.
function WorkspacePicker({
  workspaces,
  picked,
  onToggle,
}: {
  workspaces: Workspace[];
  picked: Set<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <fieldset className="grid gap-1.5">
      <legend className="mb-1.5 text-sm font-medium">Run jobs in</legend>
      <div className="divide-y rounded-md border">
        {workspaces.map((workspace) => (
          <label
            key={workspace.id}
            className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/40"
          >
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-go)]"
              checked={picked.has(workspace.id)}
              onChange={() => onToggle(workspace.id)}
            />
            <span className="min-w-0 flex-1 truncate font-mono">{workspace.name}</span>
            {workspace.joined && <span className="text-xs text-muted-foreground">Joined</span>}
          </label>
        ))}
      </div>
    </fieldset>
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

/**
 * Where and when `relayrunner connect` asked for this code. Anyone can start a sign-in and send
 * the link to someone else, so a request from another country gets a warning to stop and check.
 */
function RequestOrigin({ origin }: { origin: Extract<Loaded, { kind: "review" }>["origin"] }) {
  if (!origin?.requested_at && !origin?.requested_from) return null;
  const from = origin.requested_from;
  const place = from ? describePlace(from.country, from.city) : null;
  const parts = [
    place && `Requested from ${place}`,
    origin.requested_at &&
      (place ? timeAgo(origin.requested_at) : `Requested ${timeAgo(origin.requested_at)}`),
  ].filter(Boolean);
  return (
    <>
      <p className="text-center text-sm text-muted-foreground">{parts.join(" · ")}</p>
      {from?.differentCountry && (
        <p role="alert" className="rounded-md border border-destructive/50 px-3 py-2 text-sm">
          This request came from a different country than you. Only approve it if you just ran{" "}
          <code>relayrunner connect</code> yourself. Someone else's machine would get your jobs and
          their secrets.
        </p>
      )}
    </>
  );
}
