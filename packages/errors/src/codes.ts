/** What every code in {@link ERRORS} says about itself. */
export interface ErrorSpec {
  /** The HTTP status the API answers with. */
  status: number;
  /** The default message: a plain sentence a person or an agent can act on. */
  message: string;
}

/**
 * Every error code the API can return. A code never changes once it ships; its message can.
 * Feature-specific codes read `DOMAIN_FAILURE`, so the code alone names the feature and what
 * went wrong. Add a code here before returning it: apps/site builds the errors page and the
 * OpenAPI enum from this list.
 */
export const ERRORS = {
  // Requests
  INVALID_REQUEST: { status: 400, message: "The request isn't valid." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "The request body is too large." },
  NOT_FOUND: { status: 404, message: "Not found." },
  METHOD_NOT_ALLOWED: { status: 405, message: "That method isn't allowed here." },
  RATE_LIMITED: { status: 429, message: "Too many requests. Try again shortly." },
  INTERNAL_ERROR: { status: 500, message: "Something went wrong on our side." },

  // Sign-in and access
  UNAUTHENTICATED: { status: 401, message: "Sign in first." },
  INVALID_TOKEN: { status: 401, message: "The token is invalid, expired or revoked." },
  FORBIDDEN: { status: 403, message: "You don't have access to that." },
  AGENT_NOT_ALLOWED: { status: 403, message: "Agent tokens can't call this route." },
  AGENT_CHANGES_OFF: {
    status: 403,
    message:
      "This agent can't make changes in this workspace. Its person can turn on Allow changes for it in Settings → Agents.",
  },
  NOT_A_MEMBER: { status: 403, message: "You aren't a member of that workspace." },
  LEGAL_TERMS_OUTDATED: {
    status: 409,
    message: "The terms changed since you opened this page. Reload it to read the new version.",
  },

  // Workspaces and users
  NO_ACTIVE_WORKSPACE: { status: 409, message: "Pick a workspace first." },
  WORKSPACE_REQUIRED: {
    status: 409,
    message:
      "This token reads more than one workspace. Name one with the x-relayrunner-workspace header.",
  },
  CANNOT_DEMOTE_SELF: { status: 400, message: "You can't remove your own operator role." },
  CANNOT_DELETE_SELF: { status: 400, message: "You can't delete your own account here." },
  USER_HAS_SHARED_WORKSPACES: {
    status: 409,
    message: "The user is in workspaces with other members. Remove them from those first.",
  },

  // Machines and the CLI
  MACHINE_NOT_OWNED: { status: 403, message: "Only a machine with an owner can do this." },
  DEVICE_CODE_INVALID: {
    status: 400,
    message: "That code doesn't match a sign-in request. Check it against your terminal.",
  },
  DEVICE_CODE_EXPIRED: {
    status: 400,
    message: "That code has expired. Run `relayrunner connect` again for a new one.",
  },
  DEVICE_CODE_USED: { status: 409, message: "That code has already been used." },
  DEVICE_CODE_CLAIMED: {
    status: 403,
    message:
      "Another account already approved or denied this request. Run `relayrunner connect` again for a new code.",
  },
  WEBSOCKET_REQUIRED: { status: 426, message: "Connect with a WebSocket upgrade." },

  // Routing
  RUNNER_ORDER_INVALID: { status: 400, message: "The runner order isn't valid." },
  RUNNER_ORDER_CHANGED: {
    status: 409,
    message: "The runner order changed since you read it. Read it again, then make your change.",
  },

  // Providers and prices
  PROVIDER_UNKNOWN: { status: 400, message: "There's no provider with that id." },
  PROVIDER_INVALID: {
    status: 400,
    message: "Fill in a name, summary and labels, and use https:// links.",
  },
  PROVIDER_ID_INVALID: {
    status: 400,
    message: "Use lowercase letters, numbers and dashes for the id.",
  },
  PROVIDER_PREFIXES_INVALID: {
    status: 400,
    message: "Add at least one label prefix, three or more characters each.",
  },
  PROVIDER_EXISTS: { status: 409, message: "There's already a provider with that id." },
  PROVIDER_PREFIX_TAKEN: {
    status: 409,
    message: "Another provider, or GitHub's own runners, already use labels like that.",
  },
  PROVIDER_NOT_CONNECTED: { status: 404, message: "That provider isn't connected." },
  PROVIDER_WORKSPACE_UNCLEAR: {
    status: 409,
    message: "Name the workspace to connect it to.",
  },
  PROVIDER_TOKEN_REJECTED: {
    status: 400,
    message: "The provider didn't accept that token. Check it and its scope.",
  },
  PROVIDER_UNREACHABLE: {
    status: 502,
    message: "The provider's API didn't answer. Try again shortly.",
  },
  PRICE_INVALID: { status: 400, message: "Check the price and date." },
  PRICE_EXISTS: {
    status: 409,
    message: "That rate already has a price from that day. Remove it first to correct it.",
  },
  TOKEN_STORAGE_UNAVAILABLE: {
    status: 503,
    message: "Saving provider tokens isn't set up on this server yet.",
  },

  // Telemetry
  TELEMETRY_ENDPOINT_INVALID: {
    status: 400,
    message: "Use an https URL on the internet, like https://api.honeycomb.io.",
  },
  TELEMETRY_HEADER_MISSING: { status: 400, message: "Enter a value for each header." },
  TELEMETRY_NOT_CONFIGURED: { status: 404, message: "Telemetry isn't set up for this workspace." },
  BUCKET_INVALID: {
    status: 400,
    message: "Check the bucket settings: an https endpoint, the bucket's name and its region.",
  },
  BUCKET_SECRET_MISSING: { status: 400, message: "Enter the secret access key." },
  BUCKET_NOT_CONFIGURED: { status: 404, message: "No bucket is set up for this workspace." },

  // GitHub webhooks
  WEBHOOK_SIGNATURE_INVALID: {
    status: 401,
    message: "The webhook signature is missing or doesn't match the App's secret.",
  },
  WEBHOOK_SECRET_NOT_CONFIGURED: {
    status: 500,
    message: "The webhook secret for this App isn't set up on this server.",
  },
  WEBHOOK_ENQUEUE_FAILED: {
    status: 503,
    message: "The delivery couldn't be queued. Redeliver it from the App's settings.",
  },

  // GitHub
  GITHUB_UNAVAILABLE: {
    status: 502,
    message: "GitHub didn't answer. Try again shortly.",
  },
  GITHUB_RATE_LIMITED: {
    status: 503,
    message: "GitHub's API limit was reached. Try again shortly.",
  },
  GITHUB_APP_NOT_CONFIGURED: { status: 500, message: "The GitHub App isn't set up." },
} as const satisfies Record<string, ErrorSpec>;

export type ErrorCode = keyof typeof ERRORS;

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && Object.hasOwn(ERRORS, code);
}
