import { expect, test } from "vitest";
import type { GroupAccess } from "./github-runners.ts";
import { blockedReason, pickAccessCheckRun } from "./pick-access.ts";

const access = { groupName: "Default" } as GroupAccess;

test("blockedReason names the cause and the fix", () => {
  expect(blockedReason("not_selected", access, "acme/app")).toBe(
    "acme/app isn't in the org's Default runner group, so GitHub never offers acme/app's relay job to RelayRunner. An org owner can add acme/app to Repository access under Settings → Actions → Runner groups → Default.",
  );
  expect(blockedReason("public", access, "acme/site")).toContain(
    "doesn't allow public repositories, so GitHub never offers acme/site's relay job to RelayRunner. An org owner can turn on \"Allow public repositories\"",
  );
});

test("pickAccessCheckRun fails the commit with the reason and the run", () => {
  const check = pickAccessCheckRun("abc", "https://github.com/acme/app/actions/runs/1", "why");
  expect(check).toMatchObject({ name: "RelayRunner", headSha: "abc", conclusion: "failure" });
  expect(check.summary).toContain(
    "(https://github.com/acme/app/actions/runs/1) will stay queued: why",
  );
});
