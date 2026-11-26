import { expect, test } from "vitest";
import { sampleRouterSetup } from "./sample/router-setup.ts";
import {
  defaultPicks,
  firstRouted,
  pickedJobs,
  repoProgress,
  routeAllPrompt,
  routePrompt,
  sizable,
} from "./route-repo.ts";

test("lists repos left to route, busiest first, and counts the routed ones", () => {
  const progress = repoProgress(sampleRouterSetup());
  expect(progress.left.map((repo) => [repo.name, repo.private])).toEqual([
    ["acme/api", true],
    ["acme/web", true],
    ["acme/docs", false],
  ]);
  expect(progress.quiet.map((repo) => repo.name)).toEqual(["acme/worker"]);
  expect([progress.routed, progress.active]).toEqual([2, 5]);
});

test("starts with jobs that ship something unchecked", () => {
  const [api] = repoProgress(sampleRouterSetup()).left;
  if (!api) throw new Error("no repo left");
  expect(pickedJobs(api, defaultPicks(api))).toEqual([
    { workflow: "CI", job: "test" },
    { workflow: "CI", job: "lint" },
    { workflow: "CI", job: "e2e" },
  ]);
});

test("names the picked jobs in the prompt, and passes --exact when auto is off", () => {
  const jobs = [{ workflow: "CI", job: "test" }];
  const prompt = routePrompt("acme/api", jobs, true);
  expect(prompt).toContain("- CI / test");
  expect(prompt).toContain("--apply <those job ids> --json");
  expect(routePrompt("acme/api", jobs, false)).toContain("--apply <those job ids> --exact --json");
  expect(routePrompt("acme/worker", null, false)).toContain("--apply all");
  expect(prompt).toContain("suggest `npx skills add relayrunner/relayrunner`");
});

test("routes several repos with one PR each, checking the first", () => {
  const prompt = routeAllPrompt(
    [
      { name: "acme/web", jobs: [{ workflow: "CI", job: "build" }] },
      { name: "acme/docs", jobs: [{ workflow: "Build", job: "build" }] },
    ],
    false,
  );
  expect(prompt).toContain("- acme/web: CI / build\n- acme/docs: Build / build");
  expect(prompt).toContain("wait for my OK");
});

test("sizes only jobs the Router can size and init can name", () => {
  const job = { name: "test", legs: 1, label: "ubuntu-latest", runs: 3, minutes: 2 };
  expect(sizable(job)).toBe(true);
  expect(sizable({ ...job, name: "Unit tests" })).toBe(false);
  expect(sizable({ ...job, legs: 3 })).toBe(false);
  expect(sizable({ ...job, label: "macos-15" })).toBe(false);
  expect(sizable({ ...job, label: "ubuntu-24.04-arm" })).toBe(false);
  expect(sizable({ ...job, label: null })).toBe(false);
});

test("spots a repo's first routed run in the workflows it routed", () => {
  const progress = repoProgress(sampleRouterSetup());
  // acme/app (1) is routed; acme/api (3) isn't yet.
  expect(firstRouted(progress, 1, null)).not.toBeNull();
  expect(firstRouted(progress, 1, ["Nope"])).toBeNull();
  expect(firstRouted(progress, 3, ["CI"])).toBeNull();
});
