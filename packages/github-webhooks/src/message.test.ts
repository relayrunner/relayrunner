import { describe, expect, test } from "vitest";
import { ranSteps, toWebhookMessage } from "./message.ts";

describe("toWebhookMessage", () => {
  test("returns null for events RelayRunner ignores or payloads missing what it needs", () => {
    expect(toWebhookMessage("star", "d", { action: "created" })).toBeNull();
    expect(toWebhookMessage("workflow_job", "d", null)).toBeNull();
    expect(
      toWebhookMessage("workflow_job", "d", { action: "queued", repository: { full_name: "a/b" } }),
    ).toBeNull();
  });

  test("keeps the workflow run fields the Runs page shows", () => {
    const message = toWebhookMessage(
      "workflow_run",
      "d",
      {
        action: "completed",
        installation: { id: 7 },
        repository: { id: 3, full_name: "acme/app" },
        workflow_run: {
          id: 42,
          run_attempt: 2,
          name: "CI",
          display_title: "fix: keep picks in Default",
          event: "pull_request",
          actor: { login: "author", id: 1 },
          triggering_actor: { login: "rerunner", id: 2 },
          head_branch: "fix-picks",
          head_sha: "abc123",
          pull_requests: [{ number: 12, head: {} }],
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/acme/app/actions/runs/42/attempts/2",
          run_started_at: "2026-11-09T12:00:00Z",
          updated_at: "2026-11-09T12:04:00Z",
          jobs_url: "x",
        },
      },
      "2026-11-09T12:04:01Z",
    );
    expect(message).toEqual({
      deliveryId: "d",
      action: "completed",
      installationId: 7,
      receivedAt: "2026-11-09T12:04:01Z",
      event: "workflow_run",
      repository: { id: 3, fullName: "acme/app" },
      run: {
        id: 42,
        runAttempt: 2,
        workflowName: "CI",
        displayTitle: "fix: keep picks in Default",
        event: "pull_request",
        actorLogin: "rerunner",
        startedBy: { id: 1, login: "author" },
        triggeredBy: { id: 2, login: "rerunner" },
        headBranch: "fix-picks",
        headSha: "abc123",
        pullRequestNumber: 12,
        status: "completed",
        conclusion: "failure",
        htmlUrl: "https://github.com/acme/app/actions/runs/42/attempts/2",
        runStartedAt: "2026-11-09T12:00:00Z",
        updatedAt: "2026-11-09T12:04:00Z",
      },
    });
    expect(toWebhookMessage("workflow_run", "d", { repository: { full_name: "a/b" } })).toBeNull();
  });

  test("keeps only the installation repo fields", () => {
    const message = toWebhookMessage(
      "installation_repositories",
      "d",
      {
        action: "added",
        installation: { id: 7 },
        repositories_added: [{ id: 1, full_name: "acme/app", private: true, node_id: "x" }],
        repositories_removed: [],
      },
      "2026-11-04T00:00:00Z",
    );
    expect(message).toEqual({
      deliveryId: "d",
      action: "added",
      installationId: 7,
      receivedAt: "2026-11-04T00:00:00Z",
      event: "installation_repositories",
      installation: { id: 7, account: null, repositorySelection: "all", suspendedAt: null },
      added: [{ id: 1, fullName: "acme/app", private: true }],
      removed: [],
    });
  });

  test("summarizes the installation so the consumer can track its status", () => {
    const installation = {
      id: 7,
      account: { id: 10, login: "acme", type: "Organization", avatar_url: "x" },
      repository_selection: "all",
      suspended_at: "2026-11-04T12:00:00Z",
      permissions: {},
    };
    expect(
      toWebhookMessage("installation", "d", { action: "suspend", installation }),
    ).toMatchObject({
      installation: {
        id: 7,
        account: { id: 10, login: "acme", type: "Organization" },
        repositorySelection: "all",
        suspendedAt: "2026-11-04T12:00:00Z",
      },
    });
    // installation_repositories carries the new selection at the top level.
    expect(
      toWebhookMessage("installation_repositories", "d", {
        action: "removed",
        repository_selection: "selected",
        installation,
      }),
    ).toMatchObject({
      installation: { repositorySelection: "selected" },
    });
  });

  test("keeps who installed the App, for its workspace's owner", () => {
    const installation = { id: 7, account: { id: 10, login: "acme", type: "Organization" } };
    expect(
      toWebhookMessage("installation", "d", {
        action: "created",
        installation,
        sender: { id: 42, login: "octo" },
      }),
    ).toMatchObject({ senderId: 42 });
    expect(
      toWebhookMessage("installation", "d", { action: "created", installation }),
    ).toMatchObject({ senderId: null });
  });

  test("keeps only the repo fields of a repository event, and skips one without a repo", () => {
    const repository = {
      id: 3,
      name: "app",
      full_name: "acme/app",
      private: false,
      owner: { login: "acme" },
    };
    expect(
      toWebhookMessage(
        "repository",
        "d",
        { action: "renamed", repository, installation: { id: 7 } },
        "2026-11-04T00:00:00Z",
      ),
    ).toEqual({
      deliveryId: "d",
      action: "renamed",
      installationId: 7,
      receivedAt: "2026-11-04T00:00:00Z",
      event: "repository",
      repository: { id: 3, fullName: "acme/app", private: false },
    });
    expect(
      toWebhookMessage("repository", "d", {
        action: "created",
        repository: { full_name: "acme/app" },
      }),
    ).toBeNull();
  });

  describe("pull_request", () => {
    const payload = (action: string, extra: Record<string, unknown> = {}) => ({
      action,
      installation: { id: 7 },
      repository: { id: 1, full_name: "acme/app" },
      pull_request: { number: 3, title: "feat: x", head: { sha: "abc" }, body: "long" },
      ...extra,
    });

    test("keeps the number, title and head commit", () => {
      expect(toWebhookMessage("pull_request", "d", payload("opened"), "t")).toEqual({
        deliveryId: "d",
        action: "opened",
        installationId: 7,
        receivedAt: "t",
        event: "pull_request",
        repository: { id: 1, fullName: "acme/app" },
        pullRequest: { number: 3, title: "feat: x", headSha: "abc" },
      });
    });

    test("drops actions that don't change the title or head commit", () => {
      expect(toWebhookMessage("pull_request", "d", payload("closed"))).toBeNull();
      expect(toWebhookMessage("pull_request", "d", payload("labeled"))).toBeNull();
      expect(
        toWebhookMessage("pull_request", "d", payload("edited", { changes: { body: {} } })),
      ).toBeNull();
      expect(
        toWebhookMessage("pull_request", "d", payload("edited", { changes: { title: {} } })),
      ).not.toBeNull();
    });
  });

  describe("check_suite", () => {
    const payload = (action: string) => ({
      action,
      installation: { id: 7 },
      repository: { id: 1, full_name: "acme/app" },
      check_suite: {
        id: 99,
        head_sha: "abc",
        head_branch: "feat/x",
        pull_requests: [{ number: 3, head: { sha: "abc" } }],
        app: { id: 5672393 },
      },
    });

    test("keeps the suite id, head commit and pull request numbers", () => {
      expect(toWebhookMessage("check_suite", "d", payload("requested"), "t")).toEqual({
        deliveryId: "d",
        action: "requested",
        installationId: 7,
        receivedAt: "t",
        event: "check_suite",
        repository: { id: 1, fullName: "acme/app" },
        checkSuite: { id: 99, headSha: "abc", headBranch: "feat/x", pullRequests: [3] },
      });
      expect(toWebhookMessage("check_suite", "d", payload("rerequested"))).not.toBeNull();
    });

    test("drops completed suites", () => {
      expect(toWebhookMessage("check_suite", "d", payload("completed"))).toBeNull();
    });
  });
});

describe("ranSteps", () => {
  const step = (name: string, conclusion = "success") => ({
    name,
    conclusion,
    started_at: "2026-11-13T17:00:00Z",
  });

  test("is false when only the runner's own steps started", () => {
    expect(ranSteps([step("Set up job", "failure"), step("Run tests", "skipped")])).toBe(false);
    expect(ranSteps([step("Set up job", "failure"), step("Complete job")])).toBe(false);
  });

  test("is true once a step of the job's own started", () => {
    expect(ranSteps([step("Set up job"), step("Run tests", "failure")])).toBe(true);
  });

  test("is null without steps", () => {
    expect(ranSteps(undefined)).toBeNull();
    expect(ranSteps([])).toBeNull();
  });
});
