// What the API's BlacksmithCli Durable Object and the Blacksmith container (src/server.ts) say to
// each other. The Durable Object POSTs one request to /run and the container answers with
// Blacksmith's own JSON, unparsed: the API's adapter (apps/api/src/provider-billing/blacksmith.ts)
// reads it. The container only ever runs the read commands in src/commands.ts, whatever it's sent.

export const BLACKSMITH_PORT = 8080;

/** Check a token works: log in and read the last day's usage. */
export interface VerifyRequest {
  kind: "verify";
  token: string;
  organization: string;
}

/** Read usage and jobs from `start` to `end` (ISO 8601). */
export interface UsageRequest {
  kind: "usage";
  token: string;
  organization: string;
  start: string;
  end: string;
}

export type CliRequest = VerifyRequest | UsageRequest;

export type CliResponse =
  | {
      ok: true;
      // `blacksmith usage` output.
      usage: unknown;
      // Each `blacksmith jobs list` page, newest first. Empty for verify.
      jobPages: unknown[];
    }
  | {
      ok: false;
      // auth: Blacksmith refused the token. error: anything else.
      reason: "auth" | "error";
      message: string;
    };
