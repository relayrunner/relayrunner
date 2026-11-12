import { describe, expect, test } from "vitest";
import { catalogProviderOf, BASE_CATALOG, prefixProblem, providerCatalog } from "./catalog.ts";

const row = {
  id: "acme",
  name: "Acme",
  summary: "Hosted runners.",
  labels: "acme-*",
  prefixes: ["acme-"],
  example: null,
  setup: null,
  dashboardUrl: null,
  docsUrl: null,
  updatedBy: "op@example.com",
  updatedAt: "2026-11-12T00:00:00.000Z",
};

describe("provider catalog", () => {
  test("added providers come before Other, and match their prefixes", () => {
    const catalog = providerCatalog([row]);
    expect(catalog.map((p) => p.id).slice(-2)).toEqual(["acme", "other"]);
    expect(catalogProviderOf(catalog, ["self-hosted", "acme"])).toEqual({
      id: "acme",
      name: "Acme",
      label: "acme",
    });
    expect(catalogProviderOf(catalog, ["depot-ubuntu-24.04"])).toMatchObject({ id: "depot" });
    expect(catalogProviderOf(catalog, ["ubuntu-latest"])).toBeNull();
  });

  test("a row for a provider in code keeps its code prefixes", () => {
    const [blacksmith] = providerCatalog([{ ...row, id: "blacksmith", prefixes: [] }]);
    expect(blacksmith).toMatchObject({ name: "Acme", prefixes: ["blacksmith-"], builtIn: true });
  });

  test.each([
    [["acme-"], null],
    [[], "invalid_prefixes"],
    [["a"], "invalid_prefixes"],
    [["blacksmith-big-"], "prefix_taken"],
    [["depot"], "prefix_taken"],
    [["ubuntu-gpu"], "prefix_taken"],
  ])("prefixes %j: %s", (prefixes, problem) => {
    expect(prefixProblem(BASE_CATALOG, "acme", prefixes)).toBe(problem);
  });
});
