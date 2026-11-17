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
  logoUrl: null,
  status: "live" as const,
  featured: null,
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

  test("an Off provider matches nothing, and a provider in code can only be hidden", () => {
    const catalog = providerCatalog([
      { ...row, status: "off" },
      { ...row, id: "depot", status: "off", featured: false },
      { ...row, id: "github", status: "hidden" },
    ]);
    expect(catalogProviderOf(catalog, ["acme-2cpu"])).toBeNull();
    const byId = (id: string) => catalog.find((p) => p.id === id);
    expect(byId("depot")).toMatchObject({ status: "hidden", featured: false });
    expect(byId("github")).toMatchObject({ status: "live" });
    expect(byId("blacksmith")).toMatchObject({ status: "live", featured: true });
  });

  test.each([
    [["acme-"], null],
    [[], "PROVIDER_PREFIXES_INVALID"],
    [["a"], "PROVIDER_PREFIXES_INVALID"],
    [["blacksmith-big-"], "PROVIDER_PREFIX_TAKEN"],
    [["depot"], "PROVIDER_PREFIX_TAKEN"],
    [["ubuntu-gpu"], "PROVIDER_PREFIX_TAKEN"],
  ])("prefixes %j: %s", (prefixes, problem) => {
    expect(prefixProblem(BASE_CATALOG, "acme", prefixes)).toBe(problem);
  });
});
