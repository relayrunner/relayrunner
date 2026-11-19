import { expect, test } from "vitest";
import { sampleRouterSetup } from "./router-sample.ts";
import {
  defaultPicks,
  pickedJobs,
  repoProgress,
  routeAllPrompt,
  routePrompt,
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

test("names the picked jobs in the prompt, and asks for auto inputs when on", () => {
  const jobs = [{ workflow: "CI", job: "test" }];
  const prompt = routePrompt("acme/api", jobs, true);
  expect(prompt).toContain("- CI / test");
  expect(prompt).toContain("--apply <those job ids>");
  expect(prompt).toContain("to `auto`");
  expect(routePrompt("acme/api", jobs, false)).not.toContain("to `auto`");
  expect(routePrompt("acme/worker", null, false)).toContain("--apply all");
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
