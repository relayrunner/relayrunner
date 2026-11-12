// Tests never reach the internet: a request to anywhere but this machine fails at once. Stub
// fetch (vi.stubGlobal) in a test that needs a GitHub or other remote response.
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    throw new Error(`Tests can't reach ${url.origin}: stub fetch for it`);
  return realFetch(input, init);
}) as typeof fetch;
