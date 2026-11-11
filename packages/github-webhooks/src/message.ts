// The queue message for one verified GitHub delivery. The ingress Worker builds it and the API
// Worker's queue consumer reads it.
//
// It carries only the fields RelayRunner acts on, never the raw payload: a Cloudflare Queues
// message is capped at 128 KB, and GitHub payloads can be much larger. Add a field here when the
// consumer needs it.

export interface WorkflowJob {
  id: number;
  runId: number;
  runAttempt: number;
  name: string;
  workflowName: string | null;
  status: string;
  conclusion: string | null;
  labels: string[];
  headBranch: string | null;
  headSha: string;
  runnerName: string | null;
  createdAt: string;
  // Absent on messages from an ingress that predates them.
  startedAt?: string | null;
  completedAt?: string | null;
  // The runner's group once one took the job. GitHub-hosted runners report "GitHub Actions".
  runnerGroupName?: string | null;
}

// A workflow run (one attempt), for the Runs page: what started it and how it ended. Every action
// (requested, in_progress, completed) carries the whole run, so the newest `updatedAt` wins.
export interface WorkflowRun {
  id: number;
  runAttempt: number;
  workflowName: string | null;
  // The commit or PR title GitHub shows for the run.
  displayTitle: string | null;
  // What triggered it: push, pull_request, schedule, workflow_dispatch, and so on.
  event: string;
  // Who started this attempt (the re-runner on a re-run), else who started the run.
  actorLogin: string | null;
  // Who started the run (`actor`) and this attempt (`triggering_actor`), by GitHub account id.
  startedBy: { id: number | null; login: string } | null;
  triggeredBy: { id: number | null; login: string } | null;
  headBranch: string | null;
  headSha: string;
  // The first open pull request for the head commit, if any.
  pullRequestNumber: number | null;
  status: string;
  conclusion: string | null;
  htmlUrl: string | null;
  runStartedAt: string | null;
  updatedAt: string;
}

// A pull request whose title or head commit changed, for the App's PR title check run.
export interface PullRequest {
  number: number;
  title: string;
  headSha: string;
}

export interface InstallationRepo {
  id: number;
  fullName: string;
  private: boolean;
}

// The installation as GitHub describes it on installation events, so the consumer can keep each
// connected org's status current (account, suspension, which repos the App sees).
export interface InstallationSummary {
  id: number;
  account: { id: number; login: string; type: string } | null;
  repositorySelection: "all" | "selected";
  suspendedAt: string | null;
}

// Which GitHub App the delivery came from. Absent means the main RelayRunner App; "checks" is the
// separate, opt-in RelayRunner Checks App (lint check runs), which posts to its own webhook path.
export type WebhookApp = "checks";

// A check suite GitHub asks an App to run, on a push or a "Re-run all checks" click.
export interface CheckSuite {
  id: number;
  headSha: string;
  headBranch: string | null;
  // Open pull requests whose head is this commit, by number. Empty for forks and plain pushes.
  pullRequests: number[];
}

interface Base {
  app?: WebhookApp;
  // X-GitHub-Delivery. Unique per delivery; a manual redelivery reuses it.
  deliveryId: string;
  action: string | null;
  installationId: number | null;
  // When the ingress Worker accepted the delivery, so the consumer can tell how long it waited.
  receivedAt: string;
}

export type WebhookMessage =
  | (Base & {
      event: "workflow_job";
      repository: { id: number; fullName: string };
      job: WorkflowJob;
    })
  | (Base & {
      event: "workflow_run";
      repository: { id: number; fullName: string };
      run: WorkflowRun;
    })
  | (Base & {
      event: "installation";
      installation: InstallationSummary | null;
      repositories: InstallationRepo[];
    })
  | (Base & {
      event: "installation_repositories";
      installation: InstallationSummary | null;
      added: InstallationRepo[];
      removed: InstallationRepo[];
    })
  // A repo the installation can see was created, renamed, made public or private, transferred,
  // deleted, and so on. For "All repositories" installs it is the only event that reports new repos.
  | (Base & { event: "repository"; repository: InstallationRepo })
  | (Base & {
      event: "pull_request";
      repository: { id: number; fullName: string };
      pullRequest: PullRequest;
    })
  | (Base & {
      event: "check_suite";
      repository: { id: number; fullName: string };
      checkSuite: CheckSuite;
    });

// The pull_request actions that give a PR a new title or head commit. `edited` counts only when
// the title changed (a body edit doesn't need a new check).
const PULL_REQUEST_ACTIONS = new Set(["opened", "reopened", "synchronize", "edited"]);

// The check_suite actions that ask the App to run its checks. `completed` is only a report.
const CHECK_SUITE_ACTIONS = new Set(["requested", "rerequested"]);

// Delivery → queue message, or null when RelayRunner doesn't act on this event (or the payload is
// missing what it needs). Never throws.
export function toWebhookMessage(
  event: string,
  deliveryId: string,
  payload: unknown,
  receivedAt = new Date().toISOString(),
): WebhookMessage | null {
  if (!isRecord(payload)) return null;
  const base: Base = {
    deliveryId,
    action: typeof payload.action === "string" ? payload.action : null,
    installationId:
      isRecord(payload.installation) && typeof payload.installation.id === "number"
        ? payload.installation.id
        : null,
    receivedAt,
  };

  switch (event) {
    case "workflow_job": {
      const job = payload.workflow_job;
      const repo = payload.repository;
      if (
        !isRecord(job) ||
        !isRecord(repo) ||
        typeof job.id !== "number" ||
        typeof repo.full_name !== "string"
      )
        return null;
      return {
        ...base,
        event,
        repository: { id: Number(repo.id), fullName: repo.full_name },
        job: {
          id: job.id,
          runId: Number(job.run_id),
          runAttempt: Number(job.run_attempt ?? 1),
          name: String(job.name ?? ""),
          workflowName: stringOrNull(job.workflow_name),
          status: String(job.status ?? ""),
          conclusion: stringOrNull(job.conclusion),
          labels: Array.isArray(job.labels)
            ? job.labels.filter((label): label is string => typeof label === "string")
            : [],
          headBranch: stringOrNull(job.head_branch),
          headSha: String(job.head_sha ?? ""),
          runnerName: stringOrNull(job.runner_name),
          runnerGroupName: stringOrNull(job.runner_group_name),
          createdAt: String(job.created_at ?? ""),
          startedAt: stringOrNull(job.started_at),
          completedAt: stringOrNull(job.completed_at),
        },
      };
    }
    case "workflow_run": {
      const run = payload.workflow_run;
      const repo = payload.repository;
      if (
        !isRecord(run) ||
        !isRecord(repo) ||
        typeof run.id !== "number" ||
        typeof repo.full_name !== "string"
      )
        return null;
      const actor = isRecord(run.triggering_actor) ? run.triggering_actor : run.actor;
      const pullRequests = Array.isArray(run.pull_requests)
        ? run.pull_requests.filter(isRecord)
        : [];
      return {
        ...base,
        event,
        repository: { id: Number(repo.id), fullName: repo.full_name },
        run: {
          id: run.id,
          runAttempt: Number(run.run_attempt ?? 1),
          workflowName: stringOrNull(run.name),
          displayTitle: stringOrNull(run.display_title),
          event: String(run.event ?? ""),
          actorLogin: isRecord(actor) ? stringOrNull(actor.login) : null,
          startedBy: githubActor(run.actor),
          triggeredBy: githubActor(run.triggering_actor) ?? githubActor(run.actor),
          headBranch: stringOrNull(run.head_branch),
          headSha: String(run.head_sha ?? ""),
          pullRequestNumber:
            typeof pullRequests[0]?.number === "number" ? pullRequests[0].number : null,
          status: String(run.status ?? ""),
          conclusion: stringOrNull(run.conclusion),
          htmlUrl: stringOrNull(run.html_url),
          runStartedAt: stringOrNull(run.run_started_at),
          updatedAt: String(run.updated_at ?? base.receivedAt),
        },
      };
    }
    case "installation":
      return {
        ...base,
        event,
        installation: installationSummary(payload.installation),
        repositories: repos(payload.repositories),
      };
    case "installation_repositories":
      return {
        ...base,
        event,
        // The new selection comes at the top level of this event.
        installation: installationSummary(payload.installation, payload.repository_selection),
        added: repos(payload.repositories_added),
        removed: repos(payload.repositories_removed),
      };
    case "repository": {
      const repo = payload.repository;
      if (!isRecord(repo) || typeof repo.id !== "number" || typeof repo.full_name !== "string")
        return null;
      return {
        ...base,
        event,
        repository: { id: repo.id, fullName: repo.full_name, private: repo.private === true },
      };
    }
    case "pull_request": {
      const pr = payload.pull_request;
      const repo = payload.repository;
      if (
        !base.action ||
        !PULL_REQUEST_ACTIONS.has(base.action) ||
        (base.action === "edited" && !(isRecord(payload.changes) && "title" in payload.changes)) ||
        !isRecord(pr) ||
        !isRecord(repo) ||
        typeof pr.number !== "number" ||
        typeof pr.title !== "string" ||
        !isRecord(pr.head) ||
        typeof pr.head.sha !== "string" ||
        typeof repo.full_name !== "string"
      )
        return null;
      return {
        ...base,
        event,
        repository: { id: Number(repo.id), fullName: repo.full_name },
        pullRequest: { number: pr.number, title: pr.title, headSha: pr.head.sha },
      };
    }
    case "check_suite": {
      const suite = payload.check_suite;
      const repo = payload.repository;
      if (
        !base.action ||
        !CHECK_SUITE_ACTIONS.has(base.action) ||
        !isRecord(suite) ||
        !isRecord(repo) ||
        typeof suite.id !== "number" ||
        typeof suite.head_sha !== "string" ||
        typeof repo.full_name !== "string"
      )
        return null;
      return {
        ...base,
        event,
        repository: { id: Number(repo.id), fullName: repo.full_name },
        checkSuite: {
          id: suite.id,
          headSha: suite.head_sha,
          headBranch: stringOrNull(suite.head_branch),
          pullRequests: Array.isArray(suite.pull_requests)
            ? suite.pull_requests
                .filter(isRecord)
                .map((pr) => pr.number)
                .filter((number): number is number => typeof number === "number")
            : [],
        },
      };
    }
    default:
      return null;
  }
}

function installationSummary(value: unknown, selection?: unknown): InstallationSummary | null {
  if (!isRecord(value) || typeof value.id !== "number") return null;
  const account =
    isRecord(value.account) && typeof value.account.login === "string"
      ? {
          id: Number(value.account.id),
          login: value.account.login,
          type: String(value.account.type ?? "User"),
        }
      : null;
  const picked = selection ?? value.repository_selection;
  return {
    id: value.id,
    account,
    repositorySelection: picked === "selected" ? "selected" : "all",
    suspendedAt: stringOrNull(value.suspended_at),
  };
}

function repos(value: unknown): InstallationRepo[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((repo) => ({
    id: Number(repo.id),
    fullName: String(repo.full_name),
    private: repo.private === true,
  }));
}

function stringOrNull(value: unknown) {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function githubActor(value: unknown): { id: number | null; login: string } | null {
  if (!isRecord(value) || typeof value.login !== "string" || !value.login) return null;
  return { id: typeof value.id === "number" ? value.id : null, login: value.login };
}
