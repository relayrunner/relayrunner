import { machineRunnerName } from "@relayrunner/machine-protocol";
import { relayInputs, type RunnerKey, type RunnerOrder } from "@relayrunner/runner-order";
import type { AccountUsage } from "./actions-billing.ts";
import { describe, expect, test, vi } from "vitest";
import {
  admits,
  canClaim,
  chooseAndHold,
  chooseMachine,
  decideRoute,
  holdsMachine,
  jobContext,
  hasLabels,
  lastPicked,
  machineLabels,
  needsOwnerAccess,
  newRouteId,
  parseLabels,
  pausedMatches,
  ROUTE_HOLD_MS,
  routeIdFromLabels,
  routeLabel,
  takeHold,
  type MachineHold,
  notSharedText,
  unavailableMachines,
  type Route,
} from "./routing.ts";

const route: Route = {
  id: "0123456789ab",
  machineId: "m1",
  machineName: "Atticus's MacBook",
  installationId: 7,
  repo: "relayrunner/relayrunner-ci-tests",
  repositoryId: 100,
  runId: 9,
  createdAt: 1_000,
  state: "reserved",
};

describe("route labels", () => {
  test("a new route's label reads back as its id", () => {
    const id = newRouteId();
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(routeIdFromLabels(["self-hosted", routeLabel(id)])).toBe(id);
  });

  test("ignores case, and anything that isn't a route label, including rr-test", () => {
    expect(routeIdFromLabels(["RR-0123456789AB"])).toBe("0123456789ab");
    expect(routeIdFromLabels(["rr-test", "relayrunner", "ubuntu-latest", "rr-0123"])).toBeNull();
  });
});

describe("chooseMachine", () => {
  const machine = (
    id: string,
    online: boolean,
    state: "idle" | "busy" | null,
    labels = ["self-hosted", "macOS", "ARM64"],
  ) => ({ id, name: id, online, state, labels });

  test("never picks a paused machine", () => {
    const paused = { ...machine("paused", true, "idle"), paused: true };
    expect(chooseMachine([paused], new Set())).toBeNull();
    expect(chooseMachine([paused, machine("free", true, "idle")], new Set())?.id).toBe("free");
  });

  test("picks an online, idle machine no route holds", () => {
    const picked = chooseMachine(
      [
        machine("offline", false, null),
        machine("busy", true, "busy"),
        machine("held", true, "idle"),
        machine("free", true, "idle"),
      ],
      new Set(["held"]),
    );
    expect(picked?.id).toBe("free");
  });

  test("returns null when no machine is free", () => {
    expect(chooseMachine([machine("busy", true, "busy")], new Set())).toBeNull();
    expect(chooseMachine([machine("held", true, "idle")], new Set(["held"]))).toBeNull();
    expect(chooseMachine([], new Set())).toBeNull();
  });

  test("prefers a machine never picked, then the least recently picked", () => {
    const candidates = [
      machine("a", true, "idle"),
      machine("b", true, "idle"),
      machine("c", true, "idle"),
    ];
    const picked = new Map([
      ["a", 3_000],
      ["b", 1_000],
    ]);
    expect(chooseMachine(candidates, new Set(), picked)?.id).toBe("c");
    expect(chooseMachine(candidates.slice(0, 2), new Set(), picked)?.id).toBe("b");
  });

  test("skips held, busy and offline machines even when picked longest ago", () => {
    const picked = new Map([
      ["held", 1],
      ["busy", 1],
      ["offline", 1],
      ["free", 5_000],
    ]);
    const candidates = [
      machine("held", true, "idle"),
      machine("busy", true, "busy"),
      machine("offline", false, null),
      machine("free", true, "idle"),
    ];
    expect(chooseMachine(candidates, new Set(["held"]), picked)?.id).toBe("free");
  });

  test("ties keep the candidates' order", () => {
    const candidates = [machine("a", true, "idle"), machine("b", true, "idle")];
    expect(chooseMachine(candidates, new Set())?.id).toBe("a");
    const picked = new Map([
      ["a", 2_000],
      ["b", 2_000],
    ]);
    expect(chooseMachine(candidates, new Set(), picked)?.id).toBe("a");
  });

  test("only machines with every wanted label, before the least recently picked", () => {
    const candidates = [
      machine("linux", true, "idle", machineLabels({ os: "linux", arch: "x64" })),
      machine("mac", true, "idle", machineLabels({ os: "macos", arch: "arm64" })),
      machine("mac-busy", true, "busy", machineLabels({ os: "macos", arch: "arm64" })),
    ];
    // The Linux box was never picked, so it would win without labels.
    const picked = new Map([["mac", 5_000]]);
    expect(chooseMachine(candidates, new Set(), picked)?.id).toBe("linux");
    expect(chooseMachine(candidates, new Set(), picked, ["self-hosted"])?.id).toBe("linux");
    expect(chooseMachine(candidates, new Set(), picked, ["macOS", "ARM64"])?.id).toBe("mac");
    expect(chooseMachine(candidates, new Set(), picked, ["linux", "x64"])?.id).toBe("linux");
    // A free machine without every label is never picked.
    expect(chooseMachine(candidates, new Set(), picked, ["macOS", "X64"])).toBeNull();
    expect(chooseMachine(candidates, new Set(["mac"]), picked, ["macOS"])).toBeNull();
  });
});

describe("machine labels", () => {
  test("are GitHub's self-hosted defaults from the stored os and arch", () => {
    expect(machineLabels({ os: "macos", arch: "arm64" })).toEqual([
      "self-hosted",
      "macOS",
      "ARM64",
    ]);
    expect(machineLabels({ os: "linux", arch: "x64" })).toEqual(["self-hosted", "Linux", "X64"]);
    expect(machineLabels({ os: "windows", arch: "arm" })).toEqual([
      "self-hosted",
      "Windows",
      "ARM",
    ]);
    expect(machineLabels({ os: null, arch: null })).toEqual(["self-hosted"]);
  });

  test("match when the machine has every wanted label, ignoring case", () => {
    const mac = machineLabels({ os: "macos", arch: "arm64" });
    expect(hasLabels(mac, ["self-hosted", "macOS", "ARM64"])).toBe(true);
    expect(hasLabels(mac, ["macos", "arm64"])).toBe(true);
    expect(hasLabels(mac, ["SELF-HOSTED"])).toBe(true);
    expect(hasLabels(mac, ["macOS", "X64"])).toBe(false);
    expect(hasLabels(mac, ["linux"])).toBe(false);
    expect(hasLabels(mac, ["gpu"])).toBe(false);
  });

  test("self-hosted matches every machine", () => {
    for (const os of ["linux", "macos", "windows", null])
      expect(hasLabels(machineLabels({ os, arch: "x64" }), ["self-hosted"])).toBe(true);
  });

  test("relay inputs are comma-separated, trimmed, empties dropped", () => {
    expect(parseLabels("self-hosted, macOS ,ARM64")).toEqual(["self-hosted", "macOS", "ARM64"]);
    expect(parseLabels(" macOS,, ,ARM64, ")).toEqual(["macOS", "ARM64"]);
    expect(parseLabels("")).toEqual([]);
    expect(parseLabels("  ")).toEqual([]);
    expect(parseLabels(undefined)).toEqual([]);
  });
});

test("lastPicked keeps each machine's newest route", () => {
  const picked = lastPicked([
    { ...route, machineId: "m1", createdAt: 1_000 },
    { ...route, machineId: "m1", createdAt: 3_000 },
    { ...route, machineId: "m2", createdAt: 2_000 },
    { ...route, machineId: "m1", createdAt: 2_500 },
  ]);
  expect(picked).toEqual(
    new Map([
      ["m1", 3_000],
      ["m2", 2_000],
    ]),
  );
});

test("a route holds its machine until the job starts or the hold lapses", () => {
  expect(holdsMachine(route, 1_000)).toBe(true);
  expect(holdsMachine({ ...route, state: "dispatched" }, 1_000)).toBe(true);
  expect(holdsMachine({ ...route, state: "done" }, 1_000)).toBe(false);
  expect(holdsMachine(route, 1_000 + ROUTE_HOLD_MS)).toBe(false);
});

describe("canClaim", () => {
  const job = { jobId: 42, repositoryId: 100, runId: 9 };

  test("only a job from the route's repo and run", () => {
    expect(canClaim(route, job)).toBe(true);
    expect(canClaim(route, { ...job, repositoryId: 101 })).toBe(false);
    expect(canClaim(route, { ...job, runId: 10 })).toBe(false);
  });

  test("once claimed, only by the same job again", () => {
    const claimed = { ...route, jobId: 42, state: "dispatched" as const };
    expect(canClaim(claimed, job)).toBe(true);
    expect(canClaim(claimed, { ...job, jobId: 43 })).toBe(false);
  });
});

test("runner names start with the machine's name and stay valid", () => {
  expect(machineRunnerName("Atticus's MacBook Pro", "0123456789ab")).toBe(
    "Atticus-s-MacBook-Pro-0123456789ab",
  );
  expect(machineRunnerName("  !!  ", "0123456789ab")).toBe("machine-0123456789ab");
  expect(machineRunnerName("x".repeat(100), "0123456789ab")).toHaveLength(53);
});

describe("jobContext", () => {
  const github = (entries: [string, unknown][]) => ({
    github: { t: 2, d: entries.map(([k, v]) => ({ k, v })) },
  });

  test("reads the repo and run id from the job's github context", () => {
    expect(
      jobContext(
        github([
          ["repository", "relayrunner/relayrunner-ci-tests"],
          ["run_id", "41902043823"],
          ["run_attempt", "2"],
          ["workflow", "RelayRunner dev"],
          ["event_name", "workflow_dispatch"],
        ]),
      ),
    ).toEqual({
      repo: "relayrunner/relayrunner-ci-tests",
      runId: 41902043823,
      runAttempt: 2,
      workflow: "RelayRunner dev",
      ...relayInputs({ machine: [], github: [] }),
      startedBy: null,
      triggeredBy: null,
    });
    expect(
      jobContext(
        github([
          ["repository", { s: "a/b" }],
          ["run_id", { t: 4, n: 5 }],
        ]),
      ),
    ).toEqual({
      repo: "a/b",
      runId: 5,
      runAttempt: 1,
      workflow: null,
      ...relayInputs({ machine: [], github: [] }),
      startedBy: null,
      triggeredBy: null,
    });
  });

  test("reads who started the run and this attempt", () => {
    const run = (extra: [string, unknown][]) =>
      jobContext(github([["repository", "a/b"], ["run_id", "5"], ...extra]));
    // A first attempt: the triggering actor is the actor, so it shares the id.
    expect(
      run([
        ["actor", "atticoos"],
        ["actor_id", "656630"],
        ["triggering_actor", "Atticoos"],
      ]),
    ).toMatchObject({
      startedBy: { id: 656630, login: "atticoos" },
      triggeredBy: { id: 656630, login: "Atticoos" },
    });
    // A re-run by someone else: the context has only their login.
    expect(
      run([
        ["actor", "atticoos"],
        ["actor_id", "656630"],
        ["triggering_actor", "dependabot[bot]"],
      ]),
    ).toMatchObject({
      startedBy: { id: 656630, login: "atticoos" },
      triggeredBy: { id: null, login: "dependabot[bot]" },
    });
    // No triggering_actor reads as the actor; no actor_id keeps the login.
    expect(run([["actor", "zach"]])).toMatchObject({
      startedBy: { id: null, login: "zach" },
      triggeredBy: { id: null, login: "zach" },
    });
  });

  // From a claimed relay job (relay v1.0.0-beta.2, relayrunner-ci-tests run 42078905012): the
  // `inputs` entry exactly as logged. The `github` context is cut down to what we read, because
  // the real one carries the job's token.
  const claimed = {
    github: {
      t: 2,
      d: [
        { k: "repository", v: "relayrunner/relayrunner-ci-tests" },
        { k: "run_id", v: "42078905012" },
      ],
    },
    inputs: {
      d: [
        { k: "machine", v: "self-hosted" },
        { k: "github", v: "ubuntu-latest" },
      ],
      t: 2,
    },
  };

  test("reads the relay's machine and github inputs", () => {
    expect(jobContext(claimed)).toEqual({
      repo: "relayrunner/relayrunner-ci-tests",
      runId: 42078905012,
      runAttempt: 1,
      workflow: null,
      ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
      startedBy: null,
      triggeredBy: null,
    });
  });

  test("reads the relay's blacksmith input", () => {
    const inputs = { t: 2, d: [{ k: "blacksmith", v: " blacksmith-2vcpu-ubuntu-2404 " }] };
    expect(jobContext({ ...claimed, inputs })).toMatchObject({
      machine: [],
      github: [],
      blacksmith: ["blacksmith-2vcpu-ubuntu-2404"],
    });
  });

  test("an empty machine input means no machine labels", () => {
    const inputs = {
      t: 2,
      d: [
        { k: "machine", v: "" },
        { k: "github", v: "ubuntu-latest" },
      ],
    };
    expect(jobContext({ ...claimed, inputs })?.machine).toEqual([]);
    expect(jobContext({ ...claimed, inputs: { t: 2, d: [] } })?.machine).toEqual([]);
  });

  test("returns null when either is missing", () => {
    expect(jobContext(undefined)).toBeNull();
    expect(jobContext({})).toBeNull();
    expect(jobContext(github([["repository", "a/b"]]))).toBeNull();
    expect(jobContext(github([["run_id", "5"]]))).toBeNull();
  });
});

describe("decideRoute", () => {
  const machineFirst: RunnerOrder = { steps: [{ key: "machine" }, { key: "github" }] };
  const githubFirst: RunnerOrder = { steps: [{ key: "github" }, { key: "machine" }] };
  const both = {
    ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
    private: true,
  };
  const free = async () => "rr-0123456789ab";
  const none = async () => null;

  test("machine first: a free machine answers", async () => {
    expect(await decideRoute(machineFirst, both, free)).toEqual({
      runner: "rr-0123456789ab",
      step: "machine",
      skipped: [],
      notInOrder: [],
    });
  });

  test("machine first: no free machine falls to github", async () => {
    expect(await decideRoute(machineFirst, both, none)).toEqual({
      runner: "ubuntu-latest",
      step: "github",
      skipped: [{ key: "machine", reason: "no_machine" }],
      notInOrder: [],
    });
  });

  test("github first: github answers without looking at machines", async () => {
    const pick = vi.fn(free);
    expect(await decideRoute(githubFirst, both, pick)).toMatchObject({
      runner: "ubuntu-latest",
      step: "github",
    });
    expect(pick).not.toHaveBeenCalled();
  });

  test("a step the job didn't configure is skipped", async () => {
    expect(await decideRoute(githubFirst, { ...both, github: [] }, free)).toEqual({
      runner: "rr-0123456789ab",
      step: "machine",
      skipped: [{ key: "github", reason: "not_configured" }],
      notInOrder: [],
    });
  });

  test("a provider the order leaves out is never picked", async () => {
    const pick = vi.fn(free);
    const decision = await decideRoute(
      { steps: [{ key: "github" }] },
      { ...both, github: [] },
      pick,
    );
    expect(pick).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ runner: null, notInOrder: ["machine"] });
    expect(decision.runner === null && decision.reason).toBe(
      "No runner available: `github` isn't set on this relay; Self-hosted isn't in your runner order.",
    );
  });

  test("a provider the order leaves out is reported even when another step answers", async () => {
    expect(await decideRoute({ steps: [{ key: "machine" }] }, both, free)).toEqual({
      runner: "rr-0123456789ab",
      step: "machine",
      skipped: [],
      notInOrder: ["github"],
    });
  });

  test("nothing fits: fails with the reason for each provider", async () => {
    const decision = await decideRoute(
      { steps: [{ key: "machine" }] },
      { ...both, machine: ["macOS", "ARM64"] },
      none,
    );
    expect(decision).toMatchObject({
      runner: null,
      skipped: [{ key: "machine", reason: "no_machine" }],
      notInOrder: ["github"],
    });
    expect(decision.runner === null && decision.reason).toBe(
      "No runner available: no self-hosted machine with macOS, ARM64 is online and idle; GitHub-hosted isn't in your runner order.",
    );
  });

  test("a public repo never gets a machine", async () => {
    const pick = vi.fn(free);
    expect(await decideRoute(machineFirst, { ...both, private: false }, pick)).toEqual({
      runner: "ubuntu-latest",
      step: "github",
      skipped: [{ key: "machine", reason: "public_repo" }],
      notInOrder: [],
    });
    expect(pick).not.toHaveBeenCalled();
    const decision = await decideRoute(machineFirst, { ...both, github: [], private: false }, pick);
    expect(decision.runner === null && decision.reason).toBe(
      "No runner available: public repos never run on self-hosted machines; `github` isn't set on this relay.",
    );
  });

  test("github takes one label", async () => {
    const decision = await decideRoute(
      { steps: [{ key: "github" }] },
      { ...relayInputs({ github: ["ubuntu-latest", "macos-latest"] }), private: true },
      none,
    );
    expect(decision).toMatchObject({
      runner: null,
      skipped: [{ key: "github", reason: "too_many_labels" }],
    });
  });

  test("no machine that fits takes the job's starter: says whose they are, and falls to github", async () => {
    const notShared = async () => ({ notShared: [{ machine: "atticus-mbp", owner: "Atticus" }] });
    expect(await decideRoute(machineFirst, both, notShared)).toEqual({
      runner: "ubuntu-latest",
      step: "github",
      skipped: [
        {
          key: "machine",
          reason: "machine_not_shared",
          notShared: [{ machine: "atticus-mbp", owner: "Atticus" }],
        },
      ],
      notInOrder: [],
    });
    const failed = await decideRoute(machineFirst, { ...both, github: [] }, notShared);
    expect(failed.runner === null && failed.reason).toBe(
      "No runner available: atticus-mbp only runs Atticus's jobs; `github` isn't set on this relay.",
    );
  });

  test("every machine that fits is paused: says so, and falls to github", async () => {
    const paused = async () => ({ paused: ["atticus-mbp"] });
    expect(await decideRoute(machineFirst, both, paused)).toEqual({
      runner: "ubuntu-latest",
      step: "github",
      skipped: [{ key: "machine", reason: "machine_paused", paused: ["atticus-mbp"] }],
      notInOrder: [],
    });
    const one = await decideRoute(machineFirst, { ...both, github: [] }, paused);
    expect(one.runner === null && one.reason).toBe(
      "No runner available: the only machine that fits, atticus-mbp, is paused; `github` isn't set on this relay.",
    );
    const two = await decideRoute(machineFirst, { ...both, github: [] }, async () => ({
      paused: ["a", "b"],
    }));
    expect(two.runner === null && two.reason).toBe(
      "No runner available: every machine that fits is paused (a, b); `github` isn't set on this relay.",
    );
  });

  test("a relay with neither input fails", async () => {
    const decision = await decideRoute(machineFirst, { ...relayInputs({}), private: true }, free);
    expect(decision.runner === null && decision.reason).toBe(
      "No runner available: the relay sets no provider, such as `machine` or `github`.",
    );
  });

  describe("blacksmith", () => {
    const label = "blacksmith-2vcpu-ubuntu-2404";
    const all = { ...both, blacksmith: [label] };
    const order = (...keys: RunnerKey[]): RunnerOrder => ({
      steps: keys.map((key) => ({ key })),
    });

    test("answers the job's Blacksmith label, public repo or not", async () => {
      for (const isPrivate of [true, false]) {
        expect(
          await decideRoute(order("blacksmith", "github"), { ...all, private: isPrivate }, free),
        ).toEqual({ runner: label, step: "blacksmith", skipped: [], notInOrder: ["machine"] });
      }
    });

    test("takes the job when no machine is free, before github", async () => {
      expect(await decideRoute(order("machine", "blacksmith", "github"), all, none)).toEqual({
        runner: label,
        step: "blacksmith",
        skipped: [{ key: "machine", reason: "no_machine" }],
        notInOrder: [],
      });
    });

    test("is skipped when the relay doesn't set it, and reported when the order leaves it out", async () => {
      expect(await decideRoute(order("blacksmith", "github"), both, free)).toEqual({
        runner: "ubuntu-latest",
        step: "github",
        skipped: [{ key: "blacksmith", reason: "not_configured" }],
        notInOrder: ["machine"],
      });
      expect(await decideRoute(order("github"), all, free)).toMatchObject({
        notInOrder: ["machine", "blacksmith"],
      });
    });

    test("takes one label, and only a Blacksmith one", async () => {
      const two = await decideRoute(
        order("blacksmith"),
        { ...both, github: [], machine: [], blacksmith: [label, "blacksmith-4vcpu-ubuntu-2404"] },
        free,
      );
      expect(two).toMatchObject({ skipped: [{ key: "blacksmith", reason: "too_many_labels" }] });
      expect(two.runner === null && two.reason).toBe(
        "No runner available: `blacksmith` takes one label, not blacksmith-2vcpu-ubuntu-2404, blacksmith-4vcpu-ubuntu-2404.",
      );

      const wrong = await decideRoute(
        order("blacksmith", "github"),
        { ...both, blacksmith: ["ubuntu-latest"] },
        free,
      );
      expect(wrong).toEqual({
        runner: "ubuntu-latest",
        step: "github",
        skipped: [{ key: "blacksmith", reason: "not_provider_label" }],
        notInOrder: ["machine"],
      });
    });

    test("matches the label prefix ignoring case", async () => {
      expect(
        await decideRoute(
          order("blacksmith"),
          { ...all, blacksmith: ["Blacksmith-4vcpu-ubuntu-2404"] },
          free,
        ),
      ).toMatchObject({ runner: "Blacksmith-4vcpu-ubuntu-2404", step: "blacksmith" });
    });
  });

  describe("other hosted providers", () => {
    const order = (...keys: RunnerKey[]): RunnerOrder => ({
      steps: keys.map((key) => ({ key })),
    });

    test("each answers its own label, in order", async () => {
      const job = {
        ...both,
        machine: [],
        depot: ["depot-ubuntu-24.04"],
        "runs-on": ["runs-on=123/runner=2cpu-linux-x64"],
      };
      expect(await decideRoute(order("namespace", "depot", "runs-on"), job, free)).toEqual({
        runner: "depot-ubuntu-24.04",
        step: "depot",
        skipped: [{ key: "namespace", reason: "not_configured" }],
        notInOrder: ["github"],
      });
      expect(await decideRoute(order("runs-on", "depot"), job, free)).toMatchObject({
        runner: "runs-on=123/runner=2cpu-linux-x64",
        step: "runs-on",
      });
    });

    test("a label that isn't the provider's is skipped with an example", async () => {
      const decision = await decideRoute(
        order("ubicloud"),
        { ...both, machine: [], github: [], ubicloud: ["ubuntu-latest"] },
        free,
      );
      expect(decision.runner === null && decision.reason).toBe(
        "No runner available: `ubicloud` takes a Ubicloud label such as ubicloud-standard-2, not ubuntu-latest.",
      );
    });
  });
});

describe("pausedMatches", () => {
  const mac = ["self-hosted", "macOS", "ARM64"];
  const linux = ["self-hosted", "Linux", "X64"];

  test("names the machines when every one with the labels is paused", () => {
    const machines = [
      { name: "mbp", labels: mac, paused: true },
      { name: "box", labels: linux, paused: false },
    ];
    expect(pausedMatches(machines, ["macOS"])).toEqual(["mbp"]);
    expect(pausedMatches(machines, ["linux"])).toEqual([]);
    // Any machine: one isn't paused.
    expect(pausedMatches(machines, ["self-hosted"])).toEqual([]);
  });

  test("a mix of paused and other machines, or none that fit, isn't paused", () => {
    expect(
      pausedMatches(
        [
          { name: "a", labels: mac, paused: true },
          { name: "b", labels: mac },
        ],
        ["macOS"],
      ),
    ).toEqual([]);
    expect(pausedMatches([{ name: "a", labels: mac, paused: true }], ["Windows"])).toEqual([]);
    expect(pausedMatches([], [])).toEqual([]);
  });
});

describe("decideRoute with a minutes limit", () => {
  const job = {
    ...relayInputs({ machine: ["self-hosted"], github: ["ubuntu-latest"] }),
    private: true,
  };
  // GitHub while under 80%, then machines, then GitHub always.
  const order: RunnerOrder = {
    steps: [{ key: "github", limit: { percent: 80 } }, { key: "machine" }, { key: "github" }],
  };
  const usage = (fields: Partial<AccountUsage> = {}): AccountUsage => ({
    installationId: 1,
    accountLogin: "acme",
    accountType: "Organization",
    status: "ok",
    reason: null,
    plan: "free",
    quotaMinutes: 2000,
    usedMinutes: 1000,
    grossAmount: 6,
    netAmount: 0,
    burnRatePerHour: 30,
    budget: null,
    cycleStart: "2026-11-01T00:00:00.000Z",
    readAt: "2026-11-09T18:00:00.000Z",
    ...fields,
  });
  const free = async () => "rr-0123456789ab";
  const none = async () => null;

  test("under the limit, the limited GitHub step takes the job", async () => {
    const decision = await decideRoute(order, job, free, async () => usage());
    expect(decision).toMatchObject({ runner: "ubuntu-latest", step: "github", skipped: [] });
  });

  test("at the limit, the job goes to a machine with the numbers recorded", async () => {
    const decision = await decideRoute(order, job, free, async () => usage({ usedMinutes: 1640 }));
    expect(decision).toMatchObject({
      runner: "rr-0123456789ab",
      step: "machine",
      skipped: [
        {
          key: "github",
          reason: "minutes_limit",
          minutes: { account: "acme", usedMinutes: 1640, quotaMinutes: 2000, percent: 80 },
        },
      ],
    });
  });

  test("with no machine free, the unlimited GitHub step takes it past the limit", async () => {
    const decision = await decideRoute(order, job, none, async () => usage({ usedMinutes: 1900 }));
    expect(decision).toMatchObject({ runner: "ubuntu-latest", step: "github" });
    expect(decision.skipped.map((s) => s.reason)).toEqual(["minutes_limit", "no_machine"]);
  });

  test("under the limit but burning fast, it stops early", async () => {
    // 1,400 of 2,000 used (70%): 600 left, but 400 an hour would use it in 1.5 hours.
    const decision = await decideRoute(order, job, free, async () =>
      usage({ usedMinutes: 1400, burnRatePerHour: 400 }),
    );
    expect(decision.skipped[0]).toMatchObject({ reason: "minutes_runway" });
  });

  test("unknown usage never blocks", async () => {
    for (const read of [
      async () => null,
      async () => usage({ status: "not_available", reason: "enterprise", quotaMinutes: null }),
      async () => usage({ status: "not_available", reason: "error", usedMinutes: 5000 }),
    ]) {
      const decision = await decideRoute(order, job, none, read);
      expect(decision).toMatchObject({ step: "github", skipped: [] });
    }
  });

  test("usage is read once per pick, and only when a limited step is reached", async () => {
    const read = vi.fn(async () => usage({ usedMinutes: 1900 }));
    const twoLimited: RunnerOrder = {
      steps: [{ key: "machine" }, { key: "github", limit: { percent: 80 } }],
    };
    await decideRoute(twoLimited, job, free, read);
    expect(read).not.toHaveBeenCalled();
    const failed = await decideRoute(twoLimited, job, none, read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(failed.runner).toBeNull();
    expect(failed.runner === null && failed.reason).toContain(
      "acme has used 1,900 of its 2,000 included minutes (95%), past the 80% limit",
    );
  });
});

describe("machine sharing (#242)", () => {
  const atticus = { id: 1, login: "atticoos" };
  const zach = { id: 2, login: "zach" };
  const bot = { id: 49699333, login: "dependabot[bot]" };
  const by = (startedBy: typeof atticus | null, triggeredBy = startedBy) => ({
    startedBy,
    triggeredBy,
  });
  const mine = { sharing: "only_me" as const, ownerGithubId: 1 };
  const shared = { sharing: "anyone" as const, ownerGithubId: 2 };

  test("only_me takes a job only when its owner started both the run and the attempt", () => {
    expect(admits(mine, by(atticus))).toBe(true);
    expect(admits(mine, by(zach))).toBe(false);
    expect(admits(mine, by(bot))).toBe(false);
    // A re-run by someone else, or of someone else's run, isn't the owner's.
    expect(admits(mine, by(atticus, zach))).toBe(false);
    expect(admits(mine, by(zach, atticus))).toBe(false);
    // An id GitHub didn't give, or a run with no actor, matches nobody.
    expect(admits(mine, by({ id: null, login: "atticoos" } as never))).toBe(false);
    expect(admits(mine, by(null))).toBe(false);
    // An owner with no GitHub account matches nobody either.
    expect(admits({ sharing: "only_me", ownerGithubId: null }, by(atticus))).toBe(false);
  });

  test("anyone takes every job, bots and schedules included, as before sharing", () => {
    for (const starters of [by(atticus), by(zach), by(bot), by(null)])
      expect(admits(shared, starters)).toBe(true);
    // Left out means anyone.
    expect(admits({}, by(null))).toBe(true);
  });

  test("anyone checks its owner's repo access, except for the owner's own jobs", () => {
    // Someone else's run or attempt, a bot, a schedule: the owner must be able to read the repo.
    for (const starters of [by(atticus), by(bot), by(null), by(zach, atticus), by(atticus, zach)])
      expect(needsOwnerAccess(shared, starters)).toBe(true);
    // The owner's own run and attempt.
    expect(needsOwnerAccess(shared, by(zach))).toBe(false);
    // Left out means anyone; an owner with no GitHub account can't be checked, so always asks.
    expect(needsOwnerAccess({}, by(zach))).toBe(true);
    expect(needsOwnerAccess({ sharing: "anyone", ownerGithubId: null }, by(zach))).toBe(true);
    // only_me only takes the owner's own jobs.
    expect(needsOwnerAccess(mine, by(zach))).toBe(false);
  });

  const free = (id: string, sharing: "only_me" | "anyone", ownerGithubId: number) => ({
    id,
    name: id,
    online: true,
    state: "idle" as const,
    labels: ["self-hosted", "macOS", "ARM64"],
    sharing,
    ownerGithubId,
  });

  test("chooseMachine skips machines that won't take the job's starter", () => {
    const candidates = [free("atticus-mbp", "only_me", 1), free("mini", "anyone", 3)];
    expect(chooseMachine(candidates, new Set(), new Map(), [], by(zach))?.id).toBe("mini");
    expect(chooseMachine(candidates.slice(0, 1), new Set(), new Map(), [], by(zach))).toBeNull();
    expect(chooseMachine(candidates.slice(0, 1), new Set(), new Map(), [], by(bot))).toBeNull();
  });

  test("chooseMachine tries the starter's own machine first, then the least recently picked", () => {
    const candidates = [
      free("mini", "anyone", 3),
      free("zach-mbp", "anyone", 2),
      free("atticus-mbp", "only_me", 1),
    ];
    // Atticus's own machine wins although it was picked most recently.
    const picked = new Map([["atticus-mbp", 5_000]]);
    expect(chooseMachine(candidates, new Set(), picked, [], by(atticus))?.id).toBe("atticus-mbp");
    // Zach's own `anyone` machine wins for Zach.
    expect(chooseMachine(candidates, new Set(), picked, [], by(zach))?.id).toBe("zach-mbp");
    // Whoever started this attempt counts as the starter.
    expect(chooseMachine(candidates, new Set(), picked, [], by(atticus, zach))?.id).toBe(
      "zach-mbp",
    );
    // Nobody's own: least recently picked, as before.
    expect(chooseMachine(candidates, new Set(), new Map([["mini", 1]]), [], by(bot))?.id).toBe(
      "zach-mbp",
    );
    // A busy own machine gives way to the rest.
    const busy = candidates.map((c) =>
      c.id === "atticus-mbp" ? { ...c, state: "busy" as const } : c,
    );
    expect(chooseMachine(busy, new Set(), picked, [], by(atticus))?.id).toBe("mini");
  });

  const pool = [
    { name: "atticus-mbp", labels: ["self-hosted", "macOS"], ...mine, ownerName: "Atticus" },
    {
      name: "zach-mbp",
      labels: ["self-hosted", "macOS"],
      sharing: "only_me" as const,
      ownerGithubId: 2,
      ownerName: "Zach",
    },
    {
      name: "linux-box",
      labels: ["self-hosted", "Linux"],
      ...shared,
      ownerName: "Zach",
      paused: true,
    },
  ];

  test("unavailableMachines names the machines that won't take the starter", () => {
    expect(unavailableMachines(pool, ["macOS"], by(bot))).toEqual({
      notShared: [
        { machine: "atticus-mbp", owner: "Atticus" },
        { machine: "zach-mbp", owner: "Zach" },
      ],
    });
    // One takes the job but is busy: that's just no machine.
    expect(unavailableMachines(pool, ["macOS"], by(atticus))).toBeNull();
    // Every machine that takes it is paused.
    expect(unavailableMachines(pool, ["Linux"], by(bot))).toEqual({ paused: ["linux-box"] });
    // No machine has the labels.
    expect(unavailableMachines(pool, ["Windows"], by(atticus))).toBeNull();
  });

  test("notSharedText names the owner", () => {
    expect(notSharedText([{ machine: "atticus-mbp", owner: "Atticus" }])).toBe(
      "atticus-mbp only runs Atticus's jobs",
    );
    expect(notSharedText([{ machine: "old-mini", owner: null }])).toBe(
      "old-mini only runs its owner's jobs",
    );
    expect(
      notSharedText([
        { machine: "a", owner: "A" },
        { machine: "b", owner: "B" },
        { machine: "c", owner: "C" },
      ]),
    ).toBe("a, b and c only run their owners' jobs");
  });
});

describe("takeHold", () => {
  const want = { routeId: "r2", workspaceId: "w2" };

  test("takes a free machine until ROUTE_HOLD_MS from now", () => {
    expect(takeHold(undefined, want, 1_000)).toEqual({ ...want, until: 1_000 + ROUTE_HOLD_MS });
  });

  test("refuses while another route holds the machine", () => {
    const current: MachineHold = { routeId: "r1", workspaceId: "w1", until: 5_000 };
    expect(takeHold(current, want, 4_999)).toBeNull();
  });

  test("takes it once the other route's hold lapses", () => {
    const current: MachineHold = { routeId: "r1", workspaceId: "w1", until: 5_000 };
    expect(takeHold(current, want, 5_000)).toEqual({ ...want, until: 5_000 + ROUTE_HOLD_MS });
  });

  test("renews the same route's hold", () => {
    const current: MachineHold = { ...want, until: 5_000 };
    expect(takeHold(current, want, 4_000)).toEqual({ ...want, until: 4_000 + ROUTE_HOLD_MS });
  });
});

describe("one machine in two workspaces", () => {
  // A machine's MachineLink: one call at a time, as a Durable Object's input gate runs them, with
  // the storage read and write awaited like the real ones.
  function machineLink() {
    let stored: MachineHold | undefined;
    let queue = Promise.resolve();
    const reserve = vi.fn((want: { routeId: string; workspaceId: string }) => {
      const result = queue.then(async () => {
        const current = await Promise.resolve(stored);
        const hold = takeHold(current, want, Date.now());
        if (!hold) return false;
        stored = await Promise.resolve(hold);
        return true;
      });
      queue = result.then(() => undefined);
      return result;
    });
    return { reserve, held: () => stored };
  }

  const candidate = (id: string) => ({
    id,
    name: id,
    online: true,
    state: "idle" as const,
    labels: ["self-hosted"],
    sharing: "anyone" as const,
    ownerGithubId: 1,
  });

  // What a workspace's Router does under its own lock: choose among its candidates, then take the
  // chosen machine's hold.
  function pick(
    workspaceId: string,
    routeId: string,
    candidates: ReturnType<typeof candidate>[],
    links: Map<string, ReturnType<typeof machineLink>>,
  ) {
    return chooseAndHold(
      (taken) => chooseMachine(candidates, taken),
      (machine) => links.get(machine.id)!.reserve({ routeId, workspaceId }),
    );
  }

  test("two simultaneous picks: only one gets the machine", async () => {
    const shared = machineLink();
    const links = new Map([["m1", shared]]);
    const [a, b] = await Promise.all([
      pick("w1", "r1", [candidate("m1")], links),
      pick("w2", "r2", [candidate("m1")], links),
    ]);
    expect([a?.id, b?.id].filter(Boolean)).toEqual(["m1"]);
    expect(shared.held()).toMatchObject({ routeId: a ? "r1" : "r2", workspaceId: a ? "w1" : "w2" });
  });

  test("the pick that loses the race takes its next machine", async () => {
    const links = new Map([
      ["m1", machineLink()],
      ["m2", machineLink()],
    ]);
    const first = await pick("w1", "r1", [candidate("m1")], links);
    const second = await pick("w2", "r2", [candidate("m1"), candidate("m2")], links);
    expect(first?.id).toBe("m1");
    expect(second?.id).toBe("m2");
    expect(links.get("m1")!.reserve).toHaveBeenCalledTimes(2);
  });
});
