// A JIT config shaped like the ones GitHub mints, for tests. `runner` and `credentials` override
// fields of the .runner and .credentials files.
export function fakeJitConfig(
  routeId: string,
  overrides: { runner?: Record<string, unknown>; credentials?: Record<string, unknown> } = {},
) {
  const file = (value: unknown) =>
    Buffer.from(`﻿${JSON.stringify(value)}`, "utf8").toString("base64");
  const files = {
    ".runner": file({
      AgentId: 42,
      AgentName: `zach-mbp-${routeId}`,
      PoolId: 1,
      PoolName: "Default",
      ServerUrl: "https://pipelinesghubeus2.actions.githubusercontent.com/abc/",
      GitHubUrl: "https://github.com/acme/app",
      WorkFolder: "_work",
      UseV2Flow: true,
      ServerUrlV2: "https://broker.actions.githubusercontent.com/",
      ...overrides.runner,
    }),
    ".credentials": file({
      Scheme: "OAuth",
      Data: {
        ClientId: "client",
        AuthorizationUrl: "https://vstoken.actions.githubusercontent.com/_apis/oauth2/token/abc",
        RequireFipsCryptography: "False",
        ...overrides.credentials,
      },
    }),
    ".credentials_rsaparams": file({ d: "AQAB", modulus: "AQAB", exponent: "AQAB" }),
  };
  return Buffer.from(JSON.stringify(files), "utf8").toString("base64");
}
