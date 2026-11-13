import { describe, expect, test } from "vitest";
import worker, { wantsMarkdown } from "./index.ts";

// The asset server as the Worker sees it with not_found_handling "none": known paths answer, the
// rest are empty 404s. Records each path asked.
function fakeEnv(files: Record<string, { body: string; type: string }>) {
  const asked: string[] = [];
  const env = {
    ASSETS: {
      fetch: async (input: Request | URL) => {
        const { pathname } = new URL(input instanceof Request ? input.url : input);
        asked.push(pathname);
        const file = files[pathname];
        return file
          ? new Response(file.body, { headers: { "Content-Type": file.type } })
          : new Response(null, { status: 404 });
      },
    },
  };
  return { env, asked };
}

const FILES = {
  "/": { body: "<h1>One router</h1>", type: "text/html" },
  "/index.md": { body: "# RelayRunner", type: "text/markdown" },
  "/404": { body: "<h1>Not found</h1>", type: "text/html" },
  "/docs/concepts/routing": { body: "<h1>Routing</h1>", type: "text/html" },
  "/docs/concepts/routing.md": { body: "# Routing", type: "text/markdown" },
};

const get = (path: string, accept?: string, method = "GET") =>
  new Request(`https://relayrunner.app${path}`, {
    method,
    headers: accept ? { Accept: accept } : {},
  });

describe("site worker", () => {
  test("serves the home page as Markdown to agents that ask, and HTML to browsers", async () => {
    const { env } = fakeEnv(FILES);
    const md = await worker.fetch(get("/", "text/markdown"), env);
    expect(md.status).toBe(200);
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(md.headers.get("Vary")).toBe("Accept");
    expect(await md.text()).toBe("# RelayRunner");

    const html = await worker.fetch(
      get("/", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"),
      env,
    );
    expect(html.headers.get("Content-Type")).toBe("text/html");
    expect(html.headers.get("Vary")).toBe("Accept");
    expect(await html.text()).toBe("<h1>One router</h1>");
  });

  test("serves docs pages as Markdown", async () => {
    const { env } = fakeEnv(FILES);
    const md = await worker.fetch(get("/docs/concepts/routing/", "text/markdown"), env);
    expect(await md.text()).toBe("# Routing");
    expect(md.headers.get("Vary")).toBe("Accept");
  });

  test("answers unknown paths with a 404: Markdown for agents, the 404 page for browsers", async () => {
    const { env } = fakeEnv(FILES);
    const md = await worker.fetch(get("/nope", "text/markdown"), env);
    expect(md.status).toBe(404);
    expect(md.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    const body = await md.text();
    expect(body).toContain("# Page not found");
    expect(body).toContain("https://relayrunner.app/llms.txt");

    const html = await worker.fetch(get("/nope", "text/html"), env);
    expect(html.status).toBe(404);
    expect(await html.text()).toBe("<h1>Not found</h1>");

    const docs = await worker.fetch(get("/docs/nope", "text/markdown"), env);
    expect(docs.status).toBe(404);
    expect(await docs.text()).toContain("There's no page at `/docs/nope`.");
  });

  test("keeps campaign share images on the HTML home page only", async () => {
    const { env, asked } = fakeEnv(FILES);
    const md = await worker.fetch(get("/?utm_content=minutes", "text/markdown"), env);
    expect(await md.text()).toBe("# RelayRunner");
    expect(asked).toEqual(["/index.md"]);
  });
});

describe("wantsMarkdown", () => {
  test.each([
    ["text/markdown", true],
    ["text/markdown, text/html;q=0.9", true],
    ["text/html, text/markdown;q=0.5", false],
    ["text/markdown;q=0", false],
    ["text/html,*/*;q=0.8", false],
    ["*/*", false],
    ["", false],
  ])("Accept: %s → %s", (accept, expected) => {
    expect(wantsMarkdown(get("/", accept))).toBe(expected);
  });

  test("only for GET and HEAD", () => {
    expect(wantsMarkdown(get("/", "text/markdown", "HEAD"))).toBe(true);
    expect(wantsMarkdown(get("/", "text/markdown", "POST"))).toBe(false);
  });
});
