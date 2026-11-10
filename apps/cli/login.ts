// Enrolls this computer as a machine with the browser device-code flow (#65):
//
// 1. POST /api/auth/device/code → a user code and the dashboard's /device link.
// 2. The user opens the link (we add &name=<hostname> as the suggested machine name), picks a
//    workspace and approves.
// 3. We poll /api/auth/device/token until that happens and get a short-lived user session.
// 4. POST /api/machines/claim trades that session and the device code for the machine token.
//    The gateway deletes the session, so only the machine token stays on this computer.

import { spawn } from "node:child_process";
import { z } from "zod";
import type { Credentials } from "./credentials.ts";
import { userAgent } from "./paths.ts";

export const CLIENT_ID = "relayrunner-cli";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export class LoginError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DeviceCode {
  userCode: string;
  // The /device link with the code and suggested name filled in.
  url: string;
  expiresAt: number;
}

export interface LoginOptions {
  server: string;
  // Suggested machine name; the user can change it on the approval page.
  name: string;
  platform: { os: "linux" | "macos" | "windows"; arch: "x64" | "arm64" | "arm" };
  // Show the code and open the browser. Polling starts once it returns.
  onCode: (code: DeviceCode) => void | Promise<void>;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const CodeResponse = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

const TokenResponse = z.object({ access_token: z.string().min(1) });
const OAuthError = z.object({ error: z.string(), error_description: z.string().optional() });

const ClaimResponse = z.object({
  machine: z.object({ id: z.string().min(1), name: z.string() }),
  workspace: z.object({
    id: z.string().min(1),
    name: z.string(),
    slug: z.string().nullish(),
    // Missing from a gateway that predates #244.
    memberCount: z.number().int().nonnegative().optional(),
  }),
  token: z.string().min(1),
});

export interface LoginResult {
  credentials: Credentials;
  // How many people are in the workspace, or null if the gateway didn't say. More than one means
  // there are teammates whose jobs this machine could run.
  memberCount: number | null;
}

export async function login(options: LoginOptions): Promise<LoginResult> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const api = (path: string) => new URL(path, options.server).toString();
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetcher(api(path), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": userAgent, ...headers },
      body: JSON.stringify(body),
    });

  const codeResponse = await post("/api/auth/device/code", { client_id: CLIENT_ID }).catch(
    (error: unknown) => {
      const cause = (error as { cause?: { message?: string } }).cause?.message;
      throw new LoginError(
        "UNREACHABLE",
        `Couldn't reach RelayRunner at ${options.server}${cause ? ` (${cause})` : ""}.`,
      );
    },
  );
  if (!codeResponse.ok)
    throw new LoginError(
      "CODE_FAILED",
      `The gateway at ${options.server} wouldn't start a sign-in (HTTP ${codeResponse.status}).`,
    );
  const code = CodeResponse.parse(await codeResponse.json());

  const url = new URL(code.verification_uri_complete ?? code.verification_uri);
  if (!url.searchParams.has("user_code")) url.searchParams.set("user_code", code.user_code);
  url.searchParams.set("name", options.name);
  const expiresAt = now() + code.expires_in * 1000;
  await options.onCode({ userCode: code.user_code, url: url.toString(), expiresAt });

  let interval = (code.interval ?? 5) * 1000;
  let accessToken: string | undefined;
  while (!accessToken) {
    if (now() >= expiresAt)
      throw new LoginError("EXPIRED", "The sign-in code expired before it was approved.");
    await sleep(interval);

    let response: Response;
    try {
      response = await post("/api/auth/device/token", {
        grant_type: DEVICE_GRANT,
        device_code: code.device_code,
        client_id: CLIENT_ID,
      });
    } catch {
      continue; // Network blip: try again on the next tick.
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      accessToken = TokenResponse.parse(body).access_token;
      break;
    }
    const error = OAuthError.safeParse(body);
    switch (error.success ? error.data.error : undefined) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5000;
        continue;
      case "access_denied":
        throw new LoginError("DENIED", "The sign-in was denied in the browser.");
      case "expired_token":
        throw new LoginError("EXPIRED", "The sign-in code expired before it was approved.");
      default:
        if (response.status >= 500) continue;
        throw new LoginError(
          "TOKEN_FAILED",
          `Signing in failed: ${error.success ? (error.data.error_description ?? error.data.error) : `HTTP ${response.status}`}.`,
        );
    }
  }

  const claimResponse = await post(
    "/api/machines/claim",
    { deviceCode: code.device_code, ...options.platform },
    { authorization: `Bearer ${accessToken}` },
  );
  if (!claimResponse.ok)
    throw new LoginError(
      "CLAIM_FAILED",
      `The gateway approved the sign-in but wouldn't enroll this machine (HTTP ${claimResponse.status}).`,
    );
  const claimed = ClaimResponse.parse(await claimResponse.json());
  const { memberCount, ...workspace } = claimed.workspace;
  return {
    credentials: {
      server: new URL(options.server).origin,
      machine: { id: claimed.machine.id, name: claimed.machine.name },
      workspace,
      token: claimed.token,
    },
    memberCount: memberCount ?? null,
  };
}

// Best effort: if no browser opens, the user still has the link on screen.
export function openBrowser(url: string) {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Ignore: the link is printed.
  }
}
