import { describe, expect, test } from "vitest";
import { originFromJson, presentOrigin, requestOrigin } from "./device-origin.ts";

const edge = (headers: Record<string, string>, cf?: Record<string, unknown>) => {
  const request = new Request("http://localhost/", { headers });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  return request;
};

describe("requestOrigin", () => {
  test("reads the IP header and Cloudflare's country and city", () => {
    expect(
      requestOrigin(edge({ "cf-connecting-ip": "203.0.113.7" }, { country: "pt", city: "Lisbon" })),
    ).toEqual({ ip: "203.0.113.7", country: "PT", city: "Lisbon" });
  });

  test("unknown and Tor countries, blanks and a missing request read as null", () => {
    expect(requestOrigin(edge({}, { country: "XX", city: " " }))).toEqual({
      ip: null,
      country: null,
      city: null,
    });
    expect(requestOrigin(edge({}, { country: "T1" })).country).toBeNull();
    expect(requestOrigin(undefined)).toEqual({ ip: null, country: null, city: null });
  });
});

describe("presentOrigin", () => {
  test("flags a different country only when both are known", () => {
    const lisbon = { country: "PT", city: "Lisbon" };
    expect(presentOrigin(lisbon, { country: "US" })?.differentCountry).toBe(true);
    expect(presentOrigin(lisbon, { country: "PT" })?.differentCountry).toBe(false);
    expect(presentOrigin(lisbon, { country: null })?.differentCountry).toBeNull();
    expect(presentOrigin({ country: null, city: "Lisbon" }, { country: "US" })).toEqual({
      country: null,
      city: "Lisbon",
      differentCountry: null,
    });
  });

  test("nothing known is nothing to show", () => {
    expect(presentOrigin({ country: null, city: null }, { country: "US" })).toBeNull();
  });
});

describe("originFromJson", () => {
  test("reads an origin passed along as JSON, cleaned like requestOrigin's", () => {
    const origin = { ip: "203.0.113.9", country: "PT", city: "Lisbon" };
    expect(originFromJson(JSON.stringify(origin))).toEqual(origin);
    expect(originFromJson(JSON.stringify({ ip: 4, city: ` ${"x".repeat(100)} ` }))).toEqual({
      ip: null,
      country: null,
      city: "x".repeat(80),
    });
  });

  test("is undefined for a missing or unreadable header", () => {
    expect(originFromJson("{nope")).toBeUndefined();
    expect(originFromJson("null")).toBeUndefined();
    expect(originFromJson(null)).toBeUndefined();
  });
});
