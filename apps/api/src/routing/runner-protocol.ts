// A minimal client for GitHub's self-hosted runner protocol, which has no public spec. It uses only
import { desc } from "drizzle-orm";
import { log } from "../log.ts";
import { type Db, schema } from "../db/index.ts";
import { GitHubError } from "../github/github-api.ts";
// fetch and WebCrypto so it runs in a Durable Object. Ported from the PR #21 spike (apps/gateway),
// which tested it against github.com in November 2026; see that README for what it found.

export const userAgent = "relayrunner-gateway/0.1";

interface RsaParameters {
  d: string;
  dp: string;
  dq: string;
  exponent: string;
  inverseQ: string;
  modulus: string;
  p: string;
  q: string;
}

export interface JitConfig {
  runner: { AgentId: string; AgentName: string; ServerUrlV2: string };
  credentials: { Data: { ClientId: string; AuthorizationUrl: string } };
  rsa: RsaParameters;
}

export interface JobRequest {
  runner_request_id: string;
  run_service_url: string;
  billing_owner_id?: string;
  should_acknowledge?: boolean;
}

interface JobMessage {
  jobId: string;
  jobDisplayName: string;
  billingOwnerId?: string;
  plan: { planId: string };
  // The job's steps, as the runner's ActionStep JSON.
  steps?: unknown[];
  // The job's expression contexts (github, needs, ...), as PipelineContextData JSON.
  contextData?: Record<string, unknown>;
  // The job's variables. `system.github.token` is the job's own GITHUB_TOKEN.
  variables?: Record<string, { value?: string } | undefined>;
  resources: {
    endpoints: {
      name: string;
      url: string;
      authorization: { parameters: { AccessToken: string } };
    }[];
  };
}

export interface ClaimedJob {
  message: JobMessage;
  token: string;
  serviceUrl: string;
  // The job's GITHUB_TOKEN: scoped to the job's repo and the workflow's `permissions`, and revoked
  // by GitHub when the job completes. Only ever held in memory.
  githubToken?: string;
  // Where the job's steps and logs go (`system.github.results_endpoint`).
  resultsUrl?: string;
}

// The runner's Annotation contract (level is the AnnotationLevel enum by name). One with a path
// and line shows on that line of a pull request's diff.
export interface JobAnnotation {
  level: "FAILURE" | "WARNING" | "NOTICE";
  message: string;
  title?: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
  endColumn?: number;
  isInfrastructureIssue?: boolean;
}

export type Conclusion = "succeeded" | "failed";

const decodeText = (bytes: ArrayBuffer | Uint8Array) =>
  new TextDecoder().decode(bytes).replace(/^﻿/, "");
const base64Bytes = (value: string) =>
  Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const toBase64Url = (value: string) =>
  value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const bytesToBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  toBase64Url(btoa(String.fromCharCode(...new Uint8Array(bytes))));
const jsonToBase64Url = (value: unknown) =>
  bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
const join = (base: string, path: string) => `${base.replace(/\/+$/, "")}/${path}`;

export function decodeJitConfig(encoded: string): JitConfig {
  const files = JSON.parse(decodeText(base64Bytes(encoded))) as Record<string, string>;
  const read = <T>(name: string) => JSON.parse(decodeText(base64Bytes(files[name]))) as T;
  return {
    runner: read<JitConfig["runner"]>(".runner"),
    credentials: read<JitConfig["credentials"]>(".credentials"),
    rsa: read<RsaParameters>(".credentials_rsaparams"),
  };
}

function signingKey(rsa: RsaParameters) {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "RSA",
      n: toBase64Url(rsa.modulus),
      e: toBase64Url(rsa.exponent),
      d: toBase64Url(rsa.d),
      p: toBase64Url(rsa.p),
      q: toBase64Url(rsa.q),
      dp: toBase64Url(rsa.dp),
      dq: toBase64Url(rsa.dq),
      qi: toBase64Url(rsa.inverseQ),
    },
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

export class RunnerClient {
  private readonly jit: JitConfig;
  private readonly version: string;
  private accessToken: string | undefined;
  private accessTokenExpires = 0;
  private sessionId: string | undefined;

  // GitHub refuses to send jobs to a runner that reports an old version, so `version` has to be a
  // recent official release. With updates disabled (see poll), github.com keeps sending jobs to a
  // version for 63 days after a newer one comes out, so an hour-old lookup is fine.
  constructor(jit: JitConfig, version: string) {
    this.jit = jit;
    this.version = version;
  }

  private async token() {
    if (this.accessToken && this.accessTokenExpires > Date.now() + 60_000) return this.accessToken;
    const { ClientId: clientId, AuthorizationUrl: authorizationUrl } = this.jit.credentials.Data;
    const issuedAt = Math.floor(Date.now() / 1000) - 30;
    const unsigned = `${jsonToBase64Url({ alg: "PS256", typ: "JWT" })}.${jsonToBase64Url({
      sub: clientId,
      iss: clientId,
      aud: authorizationUrl,
      jti: crypto.randomUUID(),
      nbf: issuedAt,
      iat: issuedAt,
      exp: issuedAt + 300,
    })}`;
    const signature = await crypto.subtle.sign(
      { name: "RSA-PSS", saltLength: 32 },
      await signingKey(this.jit.rsa),
      new TextEncoder().encode(unsigned),
    );
    const response = await fetch(authorizationUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
        accept: "application/json",
        "user-agent": userAgent,
      },
      body: new URLSearchParams({
        client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: `${unsigned}.${bytesToBase64Url(signature)}`,
        grant_type: "client_credentials",
      }),
    });
    if (!response.ok) throw new Error(`Token request failed with status ${response.status}.`);
    const { access_token: token, expires_in: expiresIn = 300 } = (await response.json()) as {
      access_token: string;
      expires_in?: number;
    };
    this.accessToken = token;
    this.accessTokenExpires = Date.now() + expiresIn * 1000;
    return token;
  }

  private async request<T>(
    method: string,
    url: string,
    options: { body?: unknown; token?: string; signal?: AbortSignal } = {},
  ) {
    const { body, token = await this.token(), signal } = options;
    const response = await fetch(url, {
      method,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": userAgent,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `${method} ${new URL(url).pathname} failed with status ${response.status}: ${text.slice(0, 300)}`,
      );
    return (text ? JSON.parse(text.replace(/^﻿/, "")) : null) as T;
  }

  private query() {
    if (!this.sessionId) throw new Error("Open a session first.");
    return new URLSearchParams({
      sessionId: this.sessionId,
      status: "Online",
      runnerVersion: this.version,
      os: "Linux",
      architecture: "X64",
    });
  }

  async openSession() {
    const { AgentId: id, AgentName: name } = this.jit.runner;
    const session = await this.request<{ sessionId: string }>(
      "POST",
      join(this.jit.runner.ServerUrlV2, "session"),
      {
        body: {
          ownerName: userAgent,
          agent: {
            id: Number(id),
            name,
            version: this.version,
            osDescription: "Cloudflare Workers",
          },
          useFipsEncryption: false,
        },
      },
    );
    this.sessionId = session.sessionId;
  }

  // Long-polls once. Returns null when the poll ends without a job.
  async poll(signal?: AbortSignal) {
    const query = this.query();
    query.set("disableUpdate", "true");
    const message = await this.request<{
      messageType: string;
      body: string;
      iv?: string;
    } | null>("GET", join(this.jit.runner.ServerUrlV2, `message?${query}`), {
      signal,
    });
    if (!message) return null;
    if (message.messageType !== "RunnerJobRequest") {
      // Anything else (e.g. a broker migration) is dropped. Log its type, never its body, so a new
      // message from GitHub doesn't leave the runner idle with no trace.
      log.warn("runner.poll_message_dropped", "runner poll message dropped", {
        messageType: message.messageType,
        runner: this.jit.runner.AgentName,
      });
      return null;
    }
    if (message.iv) throw new Error("Encrypted job messages are not supported.");
    return JSON.parse(message.body) as JobRequest;
  }

  async claim(request: JobRequest): Promise<ClaimedJob> {
    if (request.should_acknowledge !== false) {
      await this.request("POST", join(this.jit.runner.ServerUrlV2, `acknowledge?${this.query()}`), {
        body: { runnerRequestId: request.runner_request_id },
      });
    }
    const message = await this.request<JobMessage>(
      "POST",
      join(request.run_service_url, "acquirejob"),
      {
        body: {
          jobMessageId: request.runner_request_id,
          runnerOS: "Linux",
          billingOwnerId: request.billing_owner_id,
        },
      },
    );
    const connection = message.resources.endpoints.find(
      (endpoint) => endpoint.name === "SystemVssConnection",
    );
    if (!connection) throw new Error("The job message has no system connection.");
    return {
      message,
      token: connection.authorization.parameters.AccessToken,
      serviceUrl: connection.url,
      githubToken: message.variables?.["system.github.token"]?.value || undefined,
      resultsUrl: message.variables?.["system.github.results_endpoint"]?.value || undefined,
    };
  }

  /**
   * Finishes the job. `error` becomes a failure annotation on the run, as a step's `::error::`
   * would, so the reason shows on the run's summary page. `annotations` follow it, such as a lint
   * problem per file and line. If GitHub turns the annotations down, the job still completes with
   * only the error, or with none, rather than being left running.
   */
  async complete(
    job: ClaimedJob,
    conclusion: Conclusion,
    {
      outputs = {},
      error,
      annotations = [],
    }: {
      outputs?: Record<string, string>;
      error?: string;
      annotations?: JobAnnotation[];
    } = {},
  ) {
    const url = join(job.serviceUrl, "completejob");
    const body = {
      planId: job.message.plan.planId,
      jobId: job.message.jobId,
      conclusion,
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([name, value]) => [name, { value, isSecret: false }]),
      ),
      billingOwnerId: job.message.billingOwnerId,
    };
    const send = (annotations: JobAnnotation[]) =>
      this.request("POST", url, {
        token: job.token,
        body: {
          ...body,
          annotations: annotations.length ? annotations : undefined,
        },
      });
    // Each attempt sends less: everything, then only the error, then nothing.
    const reason = error ? [failureAnnotation(error)] : [];
    let done = send([...reason, ...annotations]);
    if (annotations.length) done = done.catch(() => send(reason));
    if (reason.length) done = done.catch(() => send([]));
    await done;
  }

  // A session left open makes the next attempt with this runner fail with a 409.
  async closeSession() {
    if (!this.sessionId) return;
    await this.request(
      "DELETE",
      join(this.jit.runner.ServerUrlV2, `session?sessionId=${this.sessionId}`),
    );
    this.sessionId = undefined;
  }
}

const POLL_TIMEOUT_MS = 60_000;

/** Long-polls until GitHub offers the runner a job, or `waitMs` passes (null). */
export async function waitForJob(client: RunnerClient, waitMs: number) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    try {
      const request = await client.poll(AbortSignal.timeout(POLL_TIMEOUT_MS));
      if (request) return request;
    } catch (error) {
      if (!(error instanceof Error && error.name === "TimeoutError")) throw error;
    }
  }
  return null;
}

const RELEASES_LATEST_URL = "https://github.com/actions/runner/releases/latest";
/** How long a looked-up version is used before asking GitHub again. */
export const RUNNER_VERSION_TTL_MS = 60 * 60 * 1000;
/** How long the location's cache keeps a version to fall back on when GitHub fails. */
const RUNNER_VERSION_KEEP_S = 7 * 24 * 60 * 60;

type KnownVersion = { version: string; fetchedAt: number };
// This isolate's copy, kept past its TTL as the last known version.
let known: KnownVersion | undefined;

/** For tests: forget the version this isolate looked up. */
export function resetRunnerVersionCache() {
  known = undefined;
}

// The location's cache (Cache API), shared by the isolates there. It is missing outside workerd.
function locationCache(): Cache | undefined {
  return (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
}

async function readLocationCache(cache: Cache | undefined) {
  try {
    const response = await cache?.match(RELEASES_LATEST_URL);
    if (!response) return undefined;
    const version = (await response.text()).trim();
    const fetchedAt = Number(response.headers.get("x-fetched-at") ?? Number.NaN);
    return version && Number.isFinite(fetchedAt) ? { version, fetchedAt } : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLatestRunnerVersion() {
  const response = await fetch(RELEASES_LATEST_URL, {
    redirect: "manual",
    headers: { "user-agent": userAgent },
  });
  const version = response.headers.get("location")?.match(/\/tag\/v([\d.]+)$/)?.[1];
  if (!version)
    throw new GitHubError(
      response.status,
      `Could not find the latest runner version. Status ${response.status}.`,
    );
  return version;
}

/**
 * The newest actions/runner release, which RunnerClient reports to GitHub. Looked up at most once
 * an hour per isolate and location. A version up to an hour old costs nothing: GitHub keeps sending
 * jobs to an older runner for weeks after a newer release (see RunnerClient). When GitHub fails,
 * the last known version is used, so a GitHub outage doesn't hold up a pick. With none known (a
 * fresh deploy during the outage), the newest release in D1 is used: the hourly cron saves those
 * from api.github.com (src/machines/runner-releases.ts), which can answer when github.com doesn't.
 */
export async function latestRunnerVersion({
  db,
  now = Date.now(),
}: { db?: Db; now?: number } = {}) {
  if (known && now - known.fetchedAt < RUNNER_VERSION_TTL_MS) return known.version;
  const cache = locationCache();
  const cached = await readLocationCache(cache);
  if (cached && (!known || cached.fetchedAt > known.fetchedAt)) known = cached;
  if (known && now - known.fetchedAt < RUNNER_VERSION_TTL_MS) return known.version;
  try {
    const version = await fetchLatestRunnerVersion();
    known = { version, fetchedAt: now };
    await cache
      ?.put(
        RELEASES_LATEST_URL,
        new Response(version, {
          headers: {
            "cache-control": `max-age=${RUNNER_VERSION_KEEP_S}`,
            "x-fetched-at": String(now),
          },
        }),
      )
      .catch(() => {});
    return version;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (known) {
      log.warn("runner.version_lookup_failed", "using the last known runner version", {
        version: known.version,
        ageMinutes: Math.round((now - known.fetchedAt) / 60_000),
        error: message,
      });
      return known.version;
    }
    const saved = db ? await newestSavedRelease(db) : undefined;
    if (!saved) throw error;
    // Kept like a looked-up version, so the picks after this one don't wait on github.com either.
    known = { version: saved, fetchedAt: now };
    log.warn("runner.version_lookup_failed", "using the newest saved runner release", {
      version: saved,
      source: "d1",
      error: message,
    });
    return saved;
  }
}

// The newest release the cron saved, or none when D1 has none or can't be read.
async function newestSavedRelease(db: Db) {
  try {
    const [row] = await db
      .select({ version: schema.runnerRelease.version })
      .from(schema.runnerRelease)
      .orderBy(desc(schema.runnerRelease.publishedAt))
      .limit(1);
    return row?.version;
  } catch {
    return undefined;
  }
}

export function failureAnnotation(message: string): JobAnnotation {
  return { level: "FAILURE", message, isInfrastructureIssue: false };
}
