import { describe, expect, it } from "vitest";
import { parseWorkflowParam, workflowParam } from "./workflow-ref";

describe("workflow param", () => {
  it("round-trips a repo and a name, colons in the name included", () => {
    const ref = { repository: "acme/app", workflow: "Deploy: prod" };
    expect(parseWorkflowParam(workflowParam(ref))).toEqual(ref);
  });

  it("reads nothing without a repo or a name", () => {
    expect(parseWorkflowParam(undefined)).toBeUndefined();
    expect(parseWorkflowParam("acme/app")).toBeUndefined();
    expect(parseWorkflowParam(":CI")).toBeUndefined();
    expect(parseWorkflowParam("acme/app:")).toBeUndefined();
  });
});
