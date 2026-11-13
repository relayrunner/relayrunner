// Talking to GitHub as the RelayRunner App: App JWTs, installation tokens, and one-job (JIT) runner
// configs. Signed-in-user calls live in github.ts.

const API = "https://api.github.com";

const headers = (token: string) => ({
  accept: "application/vnd.github+json",
  authorization: `Bearer ${token}`,
  "user-agent": "relayrunner-gateway",
  "x-github-api-version": "2022-11-28",
});

// The org's "Default" runner group. GitHub always gives it id 1.
export const DEFAULT_RUNNER_GROUP_ID = 1;

/**
 * Import the App's private key for RS256. Accepts PKCS#8 (`BEGIN PRIVATE KEY`) or GitHub's own
 * PKCS#1 download (`BEGIN RSA PRIVATE KEY`), with or without its line breaks, since a key pasted
 * into the Secrets Store dashboard can come through either way.
 */
export async function importAppPrivateKey(pem: string): Promise<CryptoKey> {
  const pkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const body = pem.replace(/-----(BEGIN|END)[A-Z ]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (character) => character.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    pkcs1 ? pkcs1ToPkcs8(der) : der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

// PrivateKeyInfo ::= SEQUENCE { version 0, AlgorithmIdentifier rsaEncryption, OCTET STRING pkcs1 }
function pkcs1ToPkcs8(pkcs1: Uint8Array) {
  const version = [0x02, 0x01, 0x00];
  const rsaEncryption = [
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ];
  const key = der(0x04, pkcs1);
  return der(0x30, new Uint8Array([...version, ...rsaEncryption, ...key]));
}

function der(tag: number, content: Uint8Array) {
  const length =
    content.length < 0x80
      ? [content.length]
      : (() => {
          const bytes: number[] = [];
          for (let n = content.length; n > 0; n >>= 8) bytes.unshift(n & 0xff);
          return [0x80 | bytes.length, ...bytes];
        })();
  return new Uint8Array([tag, ...length, ...content]);
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const jsonBase64Url = (value: unknown) =>
  base64Url(new TextEncoder().encode(JSON.stringify(value)));

/** A short-lived JWT that authenticates as the App itself. */
export async function appJwt(appId: string, key: CryptoKey, now = Date.now()) {
  // Backdated a minute for clock drift; GitHub caps the lifetime at 10 minutes.
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${jsonBase64Url({ alg: "RS256", typ: "JWT" })}.${jsonBase64Url({ iat: issuedAt, exp: issuedAt + 540, iss: appId })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned),
  );
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

async function mintInstallationToken(jwt: string, installationId: number) {
  const response = await fetch(`${API}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: headers(jwt),
  });
  if (!response.ok)
    throw new Error(
      `POST /app/installations/${installationId}/access_tokens failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const body = (await response.json()) as { token: string; expires_at?: string };
  // GitHub's tokens last an hour; assume that if it doesn't say.
  const expiresAt = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 60 * 60_000;
  return { token: body.token, expiresAt };
}

/**
 * Where a one-job runner registers. An org install registers in the org, where one runner can take
 * any of the org's repos. A personal (User) install can't have org runners, so it registers on the
 * job's own repo, which can only take that repo's jobs.
 */
export type RunnerScope = { kind: "org"; org: string } | { kind: "repo"; repo: string };

/** The scope for a job in `repo` (owner/name) under an installation of `accountType`. */
export function runnerScope(accountType: string | null | undefined, repo: string): RunnerScope {
  return accountType === "User" ? { kind: "repo", repo } : { kind: "org", org: repo.split("/")[0] };
}

const runnersPath = (scope: RunnerScope) =>
  scope.kind === "org"
    ? `/orgs/${scope.org}/actions/runners`
    : `/repos/${scope.repo}/actions/runners`;

/**
 * Register a one-job runner and return its id and encoded config. A repo runner has no runner
 * groups of its own, but GitHub still asks for one: Default (id 1) is the only one it accepts.
 */
export async function generateJitConfig(
  token: string,
  scope: RunnerScope,
  runner: { name: string; labels: string[]; runnerGroupId?: number },
) {
  const path = `${runnersPath(scope)}/generate-jitconfig`;
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify({
      name: runner.name,
      labels: runner.labels,
      runner_group_id: (scope.kind === "org" && runner.runnerGroupId) || DEFAULT_RUNNER_GROUP_ID,
      work_folder: "_work",
    }),
  });
  if (!response.ok)
    throw Object.assign(
      new Error(
        `POST ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
      ),
      { status: response.status },
    );
  const body = (await response.json()) as {
    runner: { id: number; labels?: { name: string }[] };
    encoded_jit_config: string;
  };
  return {
    runnerId: body.runner.id,
    // The labels GitHub gave the runner, which may include defaults beyond the ones we asked for.
    labels: (body.runner.labels ?? []).map((label) => label.name),
    encodedJitConfig: body.encoded_jit_config,
  };
}

/** Remove a runner that never got a job. A JIT runner that ran one removes itself. */
export async function deleteRunner(token: string, scope: RunnerScope, runnerId: number) {
  const path = `${runnersPath(scope)}/${runnerId}`;
  const response = await fetch(`${API}${path}`, {
    method: "DELETE",
    headers: headers(token),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`DELETE ${path} failed with ${response.status}`);
}

/** A workflow job's status ("queued", "in_progress", "completed", ...), or null when it's gone. */
export async function workflowJobStatus(token: string, repo: string, jobId: number) {
  const response = await fetch(`${API}/repos/${repo}/actions/jobs/${jobId}`, {
    headers: headers(token),
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`GET /repos/${repo}/actions/jobs/${jobId} failed with ${response.status}`);
  return ((await response.json()) as { status: string }).status;
}

/** One step of a workflow job, as GitHub reports it. Times are epoch ms. */
export interface JobStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
}

/** A workflow job's steps, or null when GitHub no longer has the job. */
export async function workflowJobSteps(
  token: string,
  repo: string,
  jobId: number,
): Promise<JobStep[] | null> {
  const path = `/repos/${repo}/actions/jobs/${jobId}`;
  const response = await fetch(`${API}${path}`, { headers: headers(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  const { steps = [] } = (await response.json()) as {
    steps?: {
      number: number;
      name: string;
      status: string;
      conclusion: string | null;
      started_at?: string | null;
      completed_at?: string | null;
    }[];
  };
  const time = (value?: string | null) => (value ? Date.parse(value) : null);
  return steps.map((step) => ({
    number: step.number,
    name: step.name,
    status: step.status,
    conclusion: step.conclusion,
    startedAt: time(step.started_at),
    completedAt: time(step.completed_at),
  }));
}

/**
 * Who started one attempt of a run (its `triggering_actor`), or null when GitHub doesn't say. For
 * a pick whose context names a re-runner other than the run's actor: the context has no id.
 */
export async function runAttemptTriggeringActor(
  token: string,
  repo: string,
  runId: number,
  runAttempt: number,
): Promise<{ id: number; login: string } | null> {
  const path = `/repos/${repo}/actions/runs/${runId}/attempts/${runAttempt}`;
  const response = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  const actor = (
    (await response.json()) as { triggering_actor?: { id?: unknown; login?: unknown } }
  ).triggering_actor;
  return typeof actor?.id === "number" && typeof actor.login === "string"
    ? { id: actor.id, login: actor.login }
    : null;
}

/** Whether a runner is busy with a job, or null once it's removed (404). */
export async function runnerBusy(token: string, scope: RunnerScope, runnerId: number) {
  const path = `${runnersPath(scope)}/${runnerId}`;
  const response = await fetch(`${API}${path}`, { headers: headers(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${path} failed with ${response.status}`);
  return ((await response.json()) as { busy: boolean }).busy;
}

/** The App's installation on a repo, or null when the App isn't installed there. */
export async function repoInstallationId(jwt: string, repo: string): Promise<number | null> {
  const response = await fetch(`${API}/repos/${repo}/installation`, { headers: headers(jwt) });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(`GET /repos/${repo}/installation failed with ${response.status}`);
  return ((await response.json()) as { id: number }).id;
}

/** Every installation of the App, from its JWT. */
export async function listAppInstallations(jwt: string) {
  const installations: {
    id: number;
    account: { id: number; login: string } | null;
    suspended_at: string | null;
  }[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`${API}/app/installations?per_page=100&page=${page}`, {
      headers: headers(jwt),
    });
    if (!response.ok) throw new Error(`GET /app/installations failed with ${response.status}`);
    const batch = (await response.json()) as typeof installations;
    installations.push(...batch);
    if (batch.length < 100) return installations;
  }
}

/** An installation token from the App's id and private key, as the Durable Objects hold them. */
export async function appInstallationToken(
  env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: { get(): Promise<string> } },
  installationId: number,
  now = Date.now(),
) {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt - now > TOKEN_REUSE_MARGIN_MS) return cached.token;
  // Callers that miss together share one mint.
  let minting = mintingTokens.get(installationId);
  if (!minting) {
    minting = (async () => {
      const key = await importAppPrivateKey(await env.GITHUB_APP_PRIVATE_KEY.get());
      return mintInstallationToken(await appJwt(env.GITHUB_APP_ID, key), installationId);
    })();
    mintingTokens.set(installationId, minting);
    minting
      .then((minted) => installationTokens.set(installationId, minted))
      .catch(() => {})
      .finally(() => mintingTokens.delete(installationId));
  }
  return (await minting).token;
}

// Installation tokens by installation id, kept for the isolate's life so a page load or pick
// doesn't read the private key, sign a JWT and mint a token each time (each mint is a GitHub
// round trip, and the App can mint only so many an hour). Reused until 5 minutes before expiry.
const installationTokens = new Map<number, { token: string; expiresAt: number }>();
const mintingTokens = new Map<number, Promise<{ token: string; expiresAt: number }>>();
const TOKEN_REUSE_MARGIN_MS = 5 * 60_000;

/** Forget cached installation tokens. For tests. */
export function clearInstallationTokens() {
  installationTokens.clear();
  mintingTokens.clear();
}

/** Uninstall the App from an account, as the App. Already gone (404) counts as done. */
export async function deleteInstallation(
  env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: { get(): Promise<string> } },
  installationId: number,
) {
  const key = await importAppPrivateKey(await env.GITHUB_APP_PRIVATE_KEY.get());
  const response = await fetch(`${API}/app/installations/${installationId}`, {
    method: "DELETE",
    headers: headers(await appJwt(env.GITHUB_APP_ID, key)),
  });
  if (!response.ok && response.status !== 404)
    throw new Error(`DELETE /app/installations/${installationId} failed with ${response.status}`);
}

// listAll's cap: 10 pages of 100.
const MAX_LISTED = 1000;

// Every page of a list endpoint whose response holds its items under `key`, or is the list itself
// without one. Capped at MAX_LISTED, far more runners or groups than an org that adds runners by
// hand has.
async function listAll<T>(token: string, path: string, key?: string): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_LISTED / 100; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const body = (await getPage(token, `${path}${separator}per_page=100&page=${page}`)) as Record<
      string,
      unknown
    >;
    const batch = ((key ? body[key] : body) ?? []) as T[];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

// The last body and ETag of each listed page, by path, kept for the isolate's life. Asking again
// with the ETag gets a 304 when nothing changed, which GitHub doesn't count against the
// installation's rate limit, so polling runner lists stays nearly free. Oldest dropped past
// MAX_CACHED_PAGES.
const listedPages = new Map<string, { etag: string; body: unknown }>();
const MAX_CACHED_PAGES = 500;

/** Forget cached list pages. For tests. */
export function clearListedPages() {
  listedPages.clear();
}

// One page of a list, reusing the cached body when GitHub says it hasn't changed.
async function getPage(token: string, path: string): Promise<unknown> {
  const cached = listedPages.get(path);
  const response = await fetch(`${API}${path}`, {
    headers: cached ? { ...headers(token), "if-none-match": cached.etag } : headers(token),
  });
  if (response.status === 304 && cached) return cached.body;
  if (!response.ok)
    throw new Error(
      `GET ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const body: unknown = await response.json();
  const etag = response.headers.get("etag");
  listedPages.delete(path);
  if (etag) {
    listedPages.set(path, { etag, body });
    if (listedPages.size > MAX_CACHED_PAGES) listedPages.delete(listedPages.keys().next().value!);
  }
  return body;
}

/** A self-hosted runner registered in an org, as GET /orgs/{org}/actions/runners lists it. */
export interface OrgRunner {
  id: number;
  name: string;
  // "macOS", "Linux" or "Windows".
  os: string;
  status: "online" | "offline";
  busy: boolean;
  // Takes one job and is removed: a JIT runner, or a provider's autoscaled runner.
  ephemeral: boolean;
  labels: string[];
}

export function listOrgRunners(token: string, org: string): Promise<OrgRunner[]> {
  return listRunners(token, { kind: "org", org });
}

/** The self-hosted runners registered in an org, or on a repo. */
export async function listRunners(token: string, scope: RunnerScope): Promise<OrgRunner[]> {
  const runners = await listAll<{
    id: number;
    name: string;
    os: string;
    status: string;
    busy: boolean;
    ephemeral?: boolean;
    labels?: { name: string }[];
  }>(token, runnersPath(scope), "runners");
  return runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    os: runner.os,
    status: runner.status === "online" ? "online" : "offline",
    busy: runner.busy,
    ephemeral: runner.ephemeral ?? false,
    labels: (runner.labels ?? []).map((label) => label.name),
  }));
}

/** Adds custom labels to an org runner. GitHub keeps them on its side; the machine doesn't change. */
export async function addOrgRunnerLabels(
  token: string,
  org: string,
  runnerId: number,
  labels: string[],
) {
  await sendJson(token, "POST", `/orgs/${org}/actions/runners/${runnerId}/labels`, { labels });
}

/** Removes one custom label from an org runner. A runner or label already gone is fine. */
export async function removeOrgRunnerLabel(
  token: string,
  org: string,
  runnerId: number,
  label: string,
) {
  const response = await fetch(
    `${API}/orgs/${org}/actions/runners/${runnerId}/labels/${encodeURIComponent(label)}`,
    { method: "DELETE", headers: headers(token) },
  );
  if (!response.ok && response.status !== 404)
    throw new Error(
      `DELETE /orgs/${org}/actions/runners/${runnerId}/labels/${label} failed with ${response.status}`,
    );
}

/** An org's runner group: which repos (and workflows) may use the runners in it. */
export interface RunnerGroup {
  id: number;
  name: string;
  // all: every repo; private: private (and internal) repos; selected: the group's repo list.
  visibility: "all" | "private" | "selected";
  restrictedToWorkflows: boolean;
  // Whether public repos may use the group at all, whatever its visibility. Off by default.
  allowsPublicRepositories: boolean;
}

interface RunnerGroupBody {
  id: number;
  name: string;
  visibility: string;
  restricted_to_workflows?: boolean;
  allows_public_repositories?: boolean;
}

function toRunnerGroup(group: RunnerGroupBody): RunnerGroup {
  return {
    id: group.id,
    name: group.name,
    visibility:
      group.visibility === "all" || group.visibility === "private" ? group.visibility : "selected",
    restrictedToWorkflows: group.restricted_to_workflows === true,
    allowsPublicRepositories: group.allows_public_repositories === true,
  };
}

export async function listOrgRunnerGroups(token: string, org: string): Promise<RunnerGroup[]> {
  const groups = await listAll<RunnerGroupBody>(
    token,
    `/orgs/${org}/actions/runner-groups`,
    "runner_groups",
  );
  return groups.map(toRunnerGroup);
}

/** One of an org's runner groups, such as Default (DEFAULT_RUNNER_GROUP_ID). */
export async function getOrgRunnerGroup(token: string, org: string, groupId: number) {
  return toRunnerGroup(
    await getJson<RunnerGroupBody>(token, `/orgs/${org}/actions/runner-groups/${groupId}`),
  );
}

/** The ids of the runners in a runner group. */
export async function listRunnerGroupRunnerIds(token: string, org: string, groupId: number) {
  const runners = await listAll<{ id: number }>(
    token,
    `/orgs/${org}/actions/runner-groups/${groupId}/runners`,
    "runners",
  );
  return runners.map((runner) => runner.id);
}

/** The ids of the repos a `selected` runner group lets use its runners. */
export async function listRunnerGroupRepositoryIds(token: string, org: string, groupId: number) {
  const repos = await listAll<{ id: number }>(
    token,
    `/orgs/${org}/actions/runner-groups/${groupId}/repositories`,
    "repositories",
  );
  return repos.map((repo) => repo.id);
}

/**
 * Post a finished check run on a commit, as the App. A check with the same name on the same
 * commit replaces the earlier one on the pull request. Returns the check run's page on GitHub.
 */
export async function createCheckRun(
  token: string,
  repo: string,
  check: {
    name: string;
    headSha: string;
    conclusion: "success" | "failure";
    title: string;
    summary: string;
  },
) {
  const body = await sendJson<{ html_url?: string | null }>(
    token,
    "POST",
    `/repos/${repo}/check-runs`,
    {
      name: check.name,
      head_sha: check.headSha,
      status: "completed",
      conclusion: check.conclusion,
      output: { title: check.title, summary: check.summary },
    },
  );
  return { url: body.html_url ?? null };
}

// A check run's result. GitHub takes at most 50 annotations per request.
export interface CheckRunOutput {
  conclusion: "success" | "failure" | "neutral" | "skipped";
  title: string;
  summary: string;
  annotations?: {
    path: string;
    start_line: number;
    end_line: number;
    start_column?: number;
    end_column?: number;
    annotation_level: "notice" | "warning" | "failure";
    title?: string;
    message: string;
  }[];
}

/** Open an in-progress check run on a commit, to finish later with completeCheckRun. */
export async function startCheckRun(token: string, repo: string, name: string, headSha: string) {
  const body = await sendJson<{ id: number }>(token, "POST", `/repos/${repo}/check-runs`, {
    name,
    head_sha: headSha,
    status: "in_progress",
  });
  return body.id;
}

/** Finish a check run that startCheckRun opened. Returns its page on GitHub. */
export async function completeCheckRun(
  token: string,
  repo: string,
  checkRunId: number,
  { conclusion, ...output }: CheckRunOutput,
) {
  const body = await sendJson<{ html_url?: string | null }>(
    token,
    "PATCH",
    `/repos/${repo}/check-runs/${checkRunId}`,
    { status: "completed", conclusion, output },
  );
  return { url: body.html_url ?? null };
}

// A file a pull request touches, as GET /repos/{repo}/pulls/{n}/files lists it. GitHub leaves
// `patch` out for a binary file or a diff too large to show.
export interface PullRequestFile {
  filename: string;
  status: string;
  changes: number;
  patch?: string;
}

/**
 * The files a pull request touches, or null when it touches more than listAll reads (GitHub lists
 * at most 3,000 anyway), so the caller can treat it as touching everything.
 */
export async function pullRequestFiles(token: string, repo: string, pullRequest: number) {
  const files = await listAll<PullRequestFile>(token, `/repos/${repo}/pulls/${pullRequest}/files`);
  return files.length >= MAX_LISTED ? null : files;
}

/**
 * The repo's files at a commit, as a gzipped tarball with one top-level directory. GitHub
 * redirects to a short-lived codeload URL, which fetch follows.
 */
export async function repoTarball(token: string, repo: string, sha: string) {
  const response = await fetch(`${API}/repos/${repo}/tarball/${sha}`, { headers: headers(token) });
  if (!response.ok || !response.body) {
    const message = `GET /repos/${repo}/tarball/${sha} failed with ${response.status}`;
    throw response.status === 403 || response.status === 404
      ? new GitHubAccessError(message, response.status)
      : new Error(message);
  }
  return response.body;
}

async function sendJson<T>(token: string, method: string, path: string, body: unknown) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: { ...headers(token), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok)
    throw new Error(
      `${method} ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return (await response.json()) as T;
}

/** A file's text from the repo's default branch, or null when it doesn't exist. */
export async function repoFile(token: string, repo: string, path: string): Promise<string | null> {
  const response = await fetch(`${API}/repos/${repo}/contents/${path}`, {
    headers: { ...headers(token), accept: "application/vnd.github.raw+json" },
  });
  if (response.status === 404) return null;
  if (!response.ok)
    throw new Error(
      `GET /repos/${repo}/contents/${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  return response.text();
}

/** One rate limit bucket from GET /rate_limit. `reset` is when the window starts over. */
export interface RateLimitBucket {
  limit: number;
  used: number;
  remaining: number;
  reset: Date;
}

/** The buckets the dashboard shows. A bucket GitHub didn't send is null. */
export interface RateLimits {
  core: RateLimitBucket | null;
  graphql: RateLimitBucket | null;
  actionsRunnerRegistration: RateLimitBucket | null;
}

type RawBucket = { limit: number; used: number; remaining: number; reset: number };

/**
 * The token's primary rate limits. GET /rate_limit doesn't count against them. GitHub doesn't
 * report secondary limits anywhere.
 */
export async function rateLimits(token: string): Promise<RateLimits> {
  const response = await fetch(`${API}/rate_limit`, { headers: headers(token) });
  if (!response.ok)
    throw new Error(
      `GET /rate_limit failed with ${response.status}: ${(await response.text()).slice(0, 300)}`,
    );
  const { resources = {} } = (await response.json()) as {
    resources?: Record<string, RawBucket | undefined>;
  };
  const bucket = (raw: RawBucket | undefined): RateLimitBucket | null =>
    raw
      ? {
          limit: raw.limit,
          used: raw.used,
          remaining: raw.remaining,
          reset: new Date(raw.reset * 1000),
        }
      : null;
  return {
    core: bucket(resources.core),
    graphql: bucket(resources.graphql),
    actionsRunnerRegistration: bucket(resources.actions_runner_registration),
  };
}

/** Thrown when GitHub refuses a call for the token's permissions (403) or can't see it (404). */
export class GitHubAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function getJson<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, { headers: headers(token) });
  if (!response.ok) {
    const message = `GET ${path} failed with ${response.status}: ${(await response.text()).slice(0, 300)}`;
    if (response.status === 403 || response.status === 404)
      throw new GitHubAccessError(message, response.status);
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/**
 * Whether a GitHub user, by account id, can read a repo: any permission but `none`. GitHub answers
 * 404 for a user it doesn't know or who has no access, which reads as no.
 */
export async function userCanReadRepo(token: string, repo: string, userId: number) {
  try {
    const { login } = await getJson<{ login: string }>(token, `/user/${userId}`);
    const { permission } = await getJson<{ permission?: string }>(
      token,
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return Boolean(permission) && permission !== "none";
  } catch (error) {
    if (error instanceof GitHubAccessError && error.status === 404) return false;
    throw error;
  }
}

/** The org's GitHub plan name ("free", "team", "enterprise", ...), or null if GitHub omits it. */
export async function orgPlan(token: string, org: string): Promise<string | null> {
  const body = await getJson<{ plan?: { name?: string } }>(token, `/orgs/${org}`);
  return body.plan?.name ?? null;
}

/** One row of the org's billing usage report: a repo's usage of one SKU on one UTC day. */
export interface BillingUsageItem {
  date: string;
  product: string;
  sku: string;
  quantity: number;
  unitType: string;
  pricePerUnit?: number;
  grossAmount: number;
  discountAmount?: number;
  netAmount: number;
  repositoryName?: string;
}

/**
 * The org's usage report for one UTC month. Needs Organization Administration: read, which
 * installation tokens can use (verified on #116).
 */
export async function orgBillingUsage(
  token: string,
  org: string,
  month: { year: number; month: number },
): Promise<BillingUsageItem[]> {
  const body = await getJson<{ usageItems?: BillingUsageItem[] }>(
    token,
    `/organizations/${org}/settings/billing/usage?year=${month.year}&month=${month.month}`,
  );
  return body.usageItems ?? [];
}

/**
 * The signed-in user's own GitHub plan name ("free", "pro"), or null if GitHub omits it. GitHub
 * only shows `plan` to the user themself, so this takes their user-to-server token (#208).
 */
export async function userPlan(token: string): Promise<string | null> {
  const body = await getJson<{ plan?: { name?: string } }>(token, "/user");
  return body.plan?.name ?? null;
}

/**
 * A personal account's usage report for one UTC month, in the org report's shape. Needs the User
 * permission Plan: read and the account owner's own user-to-server token: installation tokens
 * can't call it, and a user can only read their own billing (#208).
 */
export async function userBillingUsage(
  token: string,
  login: string,
  month: { year: number; month: number },
): Promise<BillingUsageItem[]> {
  const body = await getJson<{ usageItems?: BillingUsageItem[] }>(
    token,
    `/users/${login}/settings/billing/usage?year=${month.year}&month=${month.month}`,
  );
  return body.usageItems ?? [];
}

/** An org budget, trimmed to what the minutes rule needs. Amounts are whole dollars. */
export interface BillingBudget {
  scope: string;
  type: string;
  skus: string[];
  amount: number;
  preventFurtherUsage: boolean;
}

export async function orgBudgets(token: string, org: string): Promise<BillingBudget[]> {
  const body = await getJson<{
    budgets?: {
      budget_scope: string;
      budget_type: string;
      // The schema says budget_product_sku; GitHub's examples send budget_product_skus.
      budget_product_sku?: string;
      budget_product_skus?: string[];
      budget_amount: number;
      prevent_further_usage: boolean;
    }[];
  }>(token, `/organizations/${org}/settings/billing/budgets`);
  return (body.budgets ?? []).map((budget) => ({
    scope: budget.budget_scope,
    type: budget.budget_type,
    skus:
      budget.budget_product_skus ?? (budget.budget_product_sku ? [budget.budget_product_sku] : []),
    amount: budget.budget_amount,
    preventFurtherUsage: budget.prevent_further_usage,
  }));
}
