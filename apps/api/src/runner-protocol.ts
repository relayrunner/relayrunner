// A minimal client for GitHub's self-hosted runner protocol, which has no public spec. It uses only
// fetch and WebCrypto so it runs in a Durable Object. Ported from the PR #21 spike (apps/gateway),
// which tested it against github.com in November 2026; see that README for what it found.

const userAgent = "relayrunner-gateway/0.1";

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
  // recent official release.
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
    const message = await this.request<{ messageType: string; body: string; iv?: string } | null>(
      "GET",
      join(this.jit.runner.ServerUrlV2, `message?${query}`),
      { signal },
    );
    if (!message) return null;
    if (message.messageType !== "RunnerJobRequest") {
      // Anything else (e.g. a broker migration) is dropped. Log its type, never its body, so a new
      // message from GitHub doesn't leave the runner idle with no trace.
      console.warn(
        JSON.stringify({
          msg: "runner poll message dropped",
          messageType: message.messageType,
          runner: this.jit.runner.AgentName,
        }),
      );
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
    }: { outputs?: Record<string, string>; error?: string; annotations?: JobAnnotation[] } = {},
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
        body: { ...body, annotations: annotations.length ? annotations : undefined },
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

export async function latestRunnerVersion() {
  const response = await fetch("https://github.com/actions/runner/releases/latest", {
    redirect: "manual",
    headers: { "user-agent": userAgent },
  });
  const version = response.headers.get("location")?.match(/\/tag\/v([\d.]+)$/)?.[1];
  if (!version)
    throw new Error(`Could not find the latest runner version. Status ${response.status}.`);
  return version;
}

export function failureAnnotation(message: string): JobAnnotation {
  return { level: "FAILURE", message, isInfrastructureIssue: false };
}
