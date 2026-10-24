import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { ProvenInfrastructureError } from "../server/run-admission-policy";
import { type CoordinatorOptions, type PreparedAdmission, RunCoordinator } from "../server/run-coordinator";
import type { HostAgentEvidence, HostTimelineEvidence } from "../server/run-host-evidence";
import { RunStore } from "../server/run-store";
import type { PreparedBotChat } from "../shared/chat";
import { HostCapabilityError } from "../shared/host-capability";
import { RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { newAttemptId, newExecutionId } from "../shared/runs";
import { makePrepared } from "./coordinator-fixture";
import { defined, type FakeHost, fakeHost, makeBot } from "./helpers";

const START = Date.parse("2026-10-23T10:00:00.000Z");
const CAPACITY = { global: 8, perProvider: 8, perBot: 8, perResource: 1 };
let directory: string;
let now: number;
let coordinators: RunCoordinator[];

type AgentRecord = { agent: HostAgentEvidence; timeline: HostTimelineEvidence };
interface Harness {
  coordinator: RunCoordinator;
  store: RunStore;
  host: FakeHost;
  api: PaseoApi;
  agents: Map<string, AgentRecord>;
  launches: PreparedBotChat[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function occurrence(requestId: string, patch: Partial<PreparedAdmission> = {}): PreparedAdmission {
  return {
    trigger: "manual",
    due: new Date(START),
    requestId,
    routineId: "routine-a",
    requestHash: createHash("sha256").update(requestId).digest("hex"),
    overlap: "queue",
    ...patch,
  };
}

function evidence(prepared: PreparedBotChat): AgentRecord {
  return {
    agent: {
      id: prepared.agentId,
      status: "running",
      labels: { ...prepared.labels },
      pendingPermissions: [],
      activeTurn: { turnId: "repeated-turn" },
    },
    timeline: {
      endCursor: { epoch: "host-session", seq: 1 },
      error: null,
      gap: false,
      staleCursor: false,
      hasNewer: false,
      entries: [{ seqEnd: 1, item: { type: "user_message", clientMessageId: prepared.clientMessageId } }],
    },
  };
}

async function harness(
  options: CoordinatorOptions = {},
  attached = true,
  agents = new Map<string, AgentRecord>(),
): Promise<Harness> {
  const host = fakeHost(["bot-1", "bot-b", "bot-c"].map((id) => makeBot({ id, executionMode: "managed" })));
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const record = agents.get(id);
          return record ? { agent: record.agent } : null;
        },
        timeline: { refetch: async () => defined(agents.get(id)).timeline },
      }),
    },
  } as unknown as PaseoApi;
  const launches: PreparedBotChat[] = [];
  const store = new RunStore(join(directory, "routines.json"));
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => now,
    jitter: () => 0.25,
    capacity: CAPACITY,
    refresh: async (_relay, prepared) => prepared,
    ...options,
    store,
    launch: async (hostArg, relay, prepared, observer) => {
      launches.push(structuredClone(prepared));
      const id = options.launch ? await options.launch(hostArg, relay, prepared, observer) : prepared.agentId;
      agents.set(id, evidence(prepared));
      return id;
    },
  });
  coordinators.push(coordinator);
  const result = { coordinator, store, host, api, agents, launches };
  if (attached) await attach(result);
  return result;
}

async function attach(h: Harness): Promise<void> {
  const recover = vi.spyOn(h.coordinator, "recover");
  h.host.attach(h.api);
  await defined(recover.mock.results[0]).value;
  recover.mockRestore();
}

async function close(h: Harness): Promise<void> {
  await h.coordinator.stop();
  coordinators.splice(coordinators.indexOf(h.coordinator), 1);
}

async function runOf(h: Harness, id: string): Promise<RoutineRun> {
  return defined(await h.coordinator.get(id));
}

async function created(h: Harness, run: RoutineRun): Promise<RoutineRun> {
  const result = await h.coordinator.waitForCreation(run.id);
  expect(result.status).toBe("created");
  return result.run;
}

async function observed(
  h: Harness,
  run: RoutineRun,
  status: RoutineRun["executionStatus"],
): Promise<RoutineRun> {
  await vi.waitFor(async () => expect((await runOf(h, run.id)).executionStatus).toBe(status));
  return runOf(h, run.id);
}

async function retryAt(h: Harness, run: RoutineRun, next: number): Promise<RoutineRun> {
  await vi.waitFor(async () => {
    const saved = await runOf(h, run.id);
    expect(saved.executionStatus).toBe("queued");
    expect(saved.managed?.notBefore).toBe(next);
    expect(saved.managed?.reservation).toBe(false);
  });
  return runOf(h, run.id);
}

async function complete(h: Harness, run: RoutineRun): Promise<void> {
  await h.coordinator.finished(defined(run.agentId), {
    executionId: run.executionId,
    sessionEpoch: run.sessionEpoch,
    kind: "completed",
    reply: "Observed terminal result",
  });
}

async function periodicTick(h: Harness, milliseconds: number): Promise<void> {
  const observed = deferred<void>();
  const original = h.coordinator.reconcile.bind(h.coordinator);
  const reconcile = vi.spyOn(h.coordinator, "reconcile").mockImplementation(async (id) => {
    try {
      return await original(id);
    } finally {
      observed.resolve();
    }
  });
  now += milliseconds;
  await vi.advanceTimersByTimeAsync(milliseconds);
  await observed.promise;
  await h.coordinator.pump();
  reconcile.mockRestore();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-deadline-recovery-"));
  now = START;
  coordinators = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(async () => {
  try {
    for (const coordinator of coordinators) await coordinator.stop();
  } finally {
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

describe("durable queue deadlines", () => {
  it("expires an unattached queued run across restart without creating an agent", async () => {
    const h = await harness({}, false);
    const run = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence("queued", { deadlineAt: START + 1_000 }),
    );
    expect(run.executionStatus).toBe("queued");
    expect(run.sessionEpoch).toBe(1);
    await close(h);
    now = START + 1_000;
    const reopened = await harness();
    const expired = await runOf(reopened, run.id);
    expect(expired).toMatchObject({
      executionStatus: "canceled",
      taskOutcome: "unknown",
      agentCreationStatus: "not_created",
      agentId: run.agentId,
    });
    expect(expired.managed).toMatchObject({ reservation: false, firstReservedAt: null });
    expect(reopened.launches).toHaveLength(0);
  });

  it("preserves a deferred plan across restart and refuses start after its deadline", async () => {
    const h = await harness();
    const run = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence("deferred", { deferLaunch: true, deadlineAt: START + 1_000 }),
    );
    await close(h);
    const reopened = await harness();
    expect((await runOf(reopened, run.id)).executionStatus).toBe("queued");
    expect(reopened.launches).toHaveLength(0);
    now = START + 1_000;
    const expired = await reopened.coordinator.startPrepared(run.id);
    expect(expired).toMatchObject({
      executionStatus: "canceled",
      taskOutcome: "unknown",
      agentCreationStatus: "not_created",
    });
    expect(expired.managed).toMatchObject({ launchIntent: false, reservation: false });
    expect((await reopened.coordinator.startPrepared(run.id)).executionStatus).toBe("canceled");
    expect(reopened.launches).toHaveLength(0);
  });

  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects deadlineAt=%s before any launch",
    async (deadlineAt) => {
      const h = await harness();
      await expect(
        h.coordinator.admitPrepared(makePrepared(), occurrence("invalid", { deadlineAt })),
      ).rejects.toThrow();
      expect((await h.coordinator.list()).runs).toEqual([]);
      expect(h.launches).toHaveLength(0);
    },
  );
});

function budgeted(seconds: number): PreparedBotChat {
  const prepared = makePrepared();
  prepared.metadata.resolvedPolicy.budget.maxRunSeconds.value = seconds;
  return prepared;
}

describe("execution wall-time budgets", () => {
  it("starts the budget at first reservation, not admission or queue residence", async () => {
    const h = await harness({}, false);
    const run = await h.coordinator.admitPrepared(budgeted(1), occurrence("budget"));
    now = START + 60_000;
    await attach(h);
    const running = await created(h, run);
    expect(running.executionStatus).toBe("running");
    expect(running.managed?.firstReservedAt).toBe(now);
    now += 999;
    await h.coordinator.pump();
    expect((await runOf(h, run.id)).managed?.cancelRequested).toBe(false);
    now += 1;
    await h.coordinator.pump();
    const expired = await runOf(h, run.id);
    expect(expired.executionStatus).toBe("running");
    expect(expired.managed).toMatchObject({ cancelRequested: true, reservation: true });
    expect(expired.managed?.cancelError).toMatch(/cancel/i);
    expect(expired.taskOutcome).toBe("unknown");
  });

  it("preserves the first reservation across a safe retry and process restart", async () => {
    const h = await harness({
      launch: async () => {
        throw new ProvenInfrastructureError("No create", "omp");
      },
    });
    const run = await retryAt(
      h,
      await h.coordinator.admitPrepared(budgeted(5), occurrence("retry-budget")),
      START + 2_250,
    );
    expect(run.executionStatus).toBe("queued");
    expect(run.managed?.firstReservedAt).toBe(START);
    await close(h);
    now = START + 2_250;
    const reopened = await harness();
    const retried = await created(reopened, run);
    expect(retried.executionStatus).toBe("running");
    expect(retried.managed?.firstReservedAt).toBe(START);
    now = START + 5_000;
    await reopened.coordinator.pump();
    expect((await runOf(reopened, run.id)).managed).toMatchObject({
      cancelRequested: true,
      reservation: true,
    });
    expect(h.launches.length + reopened.launches.length).toBe(2);
  });

  it("does not equate a cancellation acknowledgement with agent termination", async () => {
    const cancel = vi.fn(async () => {});
    const h = await harness({ cancel });
    const run = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence("cancel", { deadlineAt: START + 1_000 }),
    );
    await created(h, run);
    now += 1_000;
    await h.coordinator.pump();
    const pending = await runOf(h, run.id);
    expect(cancel).toHaveBeenCalledWith(run.agentId);
    expect(pending).toMatchObject({ executionStatus: "running", taskOutcome: "unknown", endedAt: null });
    expect(pending.managed).toMatchObject({ cancelRequested: true, cancelError: null, reservation: true });
    await complete(h, pending);
    expect((await runOf(h, run.id)).managed?.reservation).toBe(false);
  });
});

describe("coordinator timing limits", () => {
  it.each(["launchTimeoutMs", "reconcileIntervalMs"] as const)(
    "refuses invalid %s before acquiring a coordinator lock",
    async (option) => {
      for (const value of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(harness({ [option]: value })).rejects.toThrow();
      }
    },
  );
});

describe("bounded host launch waits", () => {
  it("launches independent work while a create hangs, then retains the uncertain reservation", async () => {
    const entered = deferred<PreparedBotChat>();
    const pending = deferred<string>();
    const h = await harness({
      launchTimeoutMs: 100,
      launch: async (_host, _relay, prepared) => {
        if (prepared.botId === "bot-1") {
          entered.resolve(prepared);
          return pending.promise;
        }
        return prepared.agentId;
      },
    });
    const admission = await h.coordinator.admitPrepared(makePrepared(), occurrence("hung"));
    expect(admission.managed?.reservation).toBe(true);
    const frozen = await entered.promise;
    const independent = await h.coordinator.admitPrepared(
      makePrepared({ botId: "bot-b", provider: "other-provider" }),
      occurrence("independent", { routineId: "routine-b" }),
    );
    expect((await created(h, independent)).executionStatus).toBe("running");
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    const uncertain = await observed(h, admission, "unknown");
    expect(uncertain.executionStatus).toBe("unknown");
    expect(uncertain.managed?.reservation).toBe(true);
    expect(uncertain.managed?.attempts).toHaveLength(1);
    expect(uncertain.agentId).toBe(frozen.agentId);
    await h.coordinator.pump();
    expect(h.launches.map((run) => run.botId)).toEqual(["bot-1", "bot-b"]);
  });

  it("abandons an unresolved create on stop without waiting for its timeout", async () => {
    const entered = deferred<void>();
    const pending = deferred<string>();
    const h = await harness({
      launch: async () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const admission = await h.coordinator.admitPrepared(makePrepared(), occurrence("stop-hung"));
    await entered.promise;
    await close(h);
    expect(admission.managed?.reservation).toBe(true);
    const disk = await h.store.read();
    const saved = defined(disk.routines["routine-a"]?.runs[0]);
    expect(saved.executionStatus).toBe("unknown");
    expect(saved.managed?.reservation).toBe(true);
    expect(h.coordinator.readiness).toBe("stopped");
  });

  it("uses a thirty-second default bound without retrying an unknown creation", async () => {
    const entered = deferred<void>();
    const pending = deferred<string>();
    const h = await harness({
      launch: async () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const admission = await h.coordinator.admitPrepared(makePrepared(), occurrence("default-bound"));
    await entered.promise;
    now += 29_999;
    await vi.advanceTimersByTimeAsync(29_999);
    const before = defined((await h.coordinator.list()).runs[0]);
    expect(before.executionStatus).toBe("starting");
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect((await observed(h, admission, "unknown")).executionStatus).toBe("unknown");
    expect(h.launches).toHaveLength(1);
  });
});

async function replaceExecution(h: Harness, run: RoutineRun): Promise<string> {
  const executionId = newExecutionId();
  await h.store.updateState((state) => {
    const saved = defined(state.routines["routine-a"]?.runs.find((entry) => entry.id === run.id));
    saved.executionId = executionId;
    saved.attemptId = newAttemptId();
    saved.agentId = randomUUID();
    const managed = defined(saved.managed);
    const previous = defined(managed.attempts.at(-1));
    previous.state = "failed";
    managed.attempts.push({
      attemptId: saved.attemptId,
      executionId,
      agentId: saved.agentId,
      idempotencyKey: executionId,
      number: previous.number + 1,
      state: "starting",
      error: null,
    });
    managed.clientMessageId = executionId;
  });
  return executionId;
}

describe("late launch result fencing", () => {
  it.each(["resolve", "reject"] as const)(
    "a late %s cannot overwrite lifecycle completion",
    async (outcome) => {
      const entered = deferred<PreparedBotChat>();
      const pending = deferred<string>();
      const h = await harness({
        launch: async (_host, _relay, prepared) => {
          entered.resolve(prepared);
          return pending.promise;
        },
      });
      await h.coordinator.admitPrepared(makePrepared(), occurrence("late-terminal"));
      const prepared = await entered.promise;
      const run = await runOf(h, prepared.labels[RUN_LABEL]);
      await complete(h, run);
      if (outcome === "resolve") pending.resolve(prepared.agentId);
      else pending.reject(new Error("Late transport failure"));
      await pending.promise.catch(() => {});
      await runOf(h, run.id);
      await close(h);
      const terminal = defined(await h.store.get(run.id));
      expect(terminal).toMatchObject({
        executionStatus: "completed",
        output: "Observed terminal result",
        taskOutcome: "unknown",
      });
      expect(terminal.managed?.reservation).toBe(false);
      expect(terminal.managed?.attempts).toHaveLength(1);
    },
  );

  it.each(["resolve", "reject"] as const)("a late %s cannot modify a newer execution", async (outcome) => {
    const entered = deferred<PreparedBotChat>();
    const pending = deferred<string>();
    const h = await harness({
      launch: async (_host, _relay, prepared) => {
        entered.resolve(prepared);
        return pending.promise;
      },
    });
    await h.coordinator.admitPrepared(makePrepared(), occurrence("late-execution"));
    const prepared = await entered.promise;
    const run = await runOf(h, prepared.labels[RUN_LABEL]);
    const nextExecution = await replaceExecution(h, run);
    if (outcome === "resolve") pending.resolve(prepared.agentId);
    else pending.reject(new ProvenInfrastructureError("Old attempt rejected", "omp"));
    await pending.promise.catch(() => {});
    await runOf(h, run.id);
    await close(h);
    const current = defined(await h.store.get(run.id));
    expect(current).toMatchObject({ executionId: nextExecution, executionStatus: "starting", error: null });
    expect(current.managed?.reservation).toBe(true);
    expect(current.managed?.hostCreatedAt).toBeUndefined();
    expect(current.managed?.attempts).toHaveLength(2);
  });
});

describe("periodic supported host reconciliation", () => {
  it("recovers missed completion hooks and captures timeline evidence", async () => {
    const h = await harness({ reconcileIntervalMs: 100 });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence("missed-completion"));
    await created(h, run);
    const record = defined(h.agents.get(defined(run.agentId)));
    record.agent.status = "idle";
    record.agent.attentionReason = "finished";
    record.agent.attentionTimestamp = new Date(START + 50).toISOString();
    record.timeline.entries.push({
      seqEnd: 2,
      item: { type: "assistant_message", text: "Observed final reply" },
    });
    record.timeline.endCursor = { epoch: "host-session", seq: 2 };
    await periodicTick(h, 100);
    const recovered = await runOf(h, run.id);
    expect(recovered).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      output: "Observed final reply",
    });
    expect(recovered.managed).toMatchObject({ reservation: false, evidence: { source: "timeline" } });
    expect(recovered.managed?.hostCreatedAt).toBe(START);
    expect(h.launches).toHaveLength(1);
  });

  it("discovers permission wait without a lifecycle callback", async () => {
    const h = await harness({ reconcileIntervalMs: 100 });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence("missed-permission"));
    await created(h, run);
    defined(h.agents.get(defined(run.agentId))).agent.pendingPermissions = [{ id: "approval" }];
    await periodicTick(h, 100);
    const waiting = await runOf(h, run.id);
    expect(waiting.executionStatus).toBe("waiting_for_user");
    expect(waiting.managed?.reservation).toBe(true);
    expect(h.launches).toHaveLength(1);
  });

  it.each(["gap", "staleCursor"] as const)(
    "does not release uncertain work with a %s timeline",
    async (field) => {
      const h = await harness({ reconcileIntervalMs: 100 });
      const run = await h.coordinator.admitPrepared(makePrepared(), occurrence("incomplete-timeline"));
      await created(h, run);
      const record = defined(h.agents.get(defined(run.agentId)));
      record.agent.status = "idle";
      record.agent.attentionReason = "finished";
      record.agent.attentionTimestamp = new Date(START + 50).toISOString();
      record.timeline[field] = true;
      await periodicTick(h, 100);
      const uncertain = await runOf(h, run.id);
      expect(uncertain.executionStatus).toBe("unknown");
      expect(uncertain.managed?.reservation).toBe(true);
      expect(uncertain.managed?.evidence).toMatchObject({ replyComplete: false, timelineComplete: false });
      expect(h.launches).toHaveLength(1);
    },
  );
});

describe("overlap-safe periodic recovery", () => {
  it("does not begin another reconciliation while the previous observation is pending", async () => {
    const entered = deferred<void>();
    const pending = deferred<PreparedBotChat>();
    const h = await harness({
      reconcileIntervalMs: 100,
      refresh: async () => {
        entered.resolve();
        return pending.promise;
      },
    });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence("slow-observation"));
    await created(h, run);
    const reconcile = vi.spyOn(h.coordinator, "reconcile");
    now += 100;
    await vi.advanceTimersByTimeAsync(100);
    await entered.promise;
    now += 300;
    await vi.advanceTimersByTimeAsync(300);
    expect(reconcile).toHaveBeenCalledTimes(1);
    pending.resolve(defined(h.launches[0]));
    await defined(reconcile.mock.results[0]).value;
    expect((await runOf(h, run.id)).executionStatus).toBe("running");
    expect((await runOf(h, run.id)).managed?.reservation).toBe(true);
    reconcile.mockRestore();
  });
});

describe("stopped periodic recovery", () => {
  it("stops host observation and refuses new admissions after shutdown", async () => {
    const h = await harness({ reconcileIntervalMs: 100 });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence("before-stop"));
    await created(h, run);
    const ref = vi.spyOn(h.api.agents, "ref");
    await periodicTick(h, 100);
    const observed = ref.mock.calls.length;
    await close(h);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ref).toHaveBeenCalledTimes(observed);
    await expect(h.coordinator.admitPrepared(makePrepared(), occurrence("after-stop"))).rejects.toThrow();
    expect(h.launches).toHaveLength(1);
  });
});

describe("durable FIFO admission", () => {
  it("uses admission order rather than routine map grouping after capacity is released", async () => {
    const h = await harness({ capacity: { global: 1 } });
    const firstB = await h.coordinator.admitPrepared(
      makePrepared({ botId: "bot-b" }),
      occurrence("first-b", { routineId: "b" }),
    );
    await created(h, firstB);
    const oldA = await h.coordinator.admitPrepared(makePrepared(), occurrence("old-a", { routineId: "a" }));
    const newB = await h.coordinator.admitPrepared(
      makePrepared({ botId: "bot-b" }),
      occurrence("new-b", { routineId: "b" }),
    );
    expect(oldA.executionStatus).toBe("queued");
    expect(newB.executionStatus).toBe("queued");
    expect(defined(oldA.managed?.admissionOrder)).toBeLessThan(defined(newB.managed?.admissionOrder));
    await close(h);
    const reopened = await harness({ capacity: { global: 1 } }, true, h.agents);
    await complete(reopened, firstB);
    await created(reopened, oldA);
    expect((await runOf(reopened, oldA.id)).executionStatus).toBe("running");
    expect((await runOf(reopened, newB.id)).executionStatus).toBe("queued");
    expect(reopened.launches.map((prepared) => prepared.labels[RUN_LABEL])).toEqual([oldA.id]);
  });

  it("keeps resource IDs opaque while contending on exact IDs across bots", async () => {
    const h = await harness();
    const writer = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence("writer", { resourceIds: ["a/../b", "a/../b"] }),
    );
    await created(h, writer);
    const independent = await h.coordinator.admitPrepared(
      makePrepared({ botId: "bot-b" }),
      occurrence("different-resource", { routineId: "b", resourceIds: ["b"] }),
    );
    await created(h, independent);
    const blocked = await h.coordinator.admitPrepared(
      makePrepared({ botId: "bot-c" }),
      occurrence("same-resource", { routineId: "c", resourceIds: ["a/../b"] }),
    );
    expect((await runOf(h, independent.id)).executionStatus).toBe("running");
    expect(blocked.executionStatus).toBe("queued");
    await complete(h, writer);
    await created(h, blocked);
    expect((await runOf(h, blocked.id)).executionStatus).toBe("running");
  });
});

describe("retry deadlines and deterministic host refusal", () => {
  it("expires before a Retry-After beyond the deadline without another create", async () => {
    const h = await harness({
      launch: async () => {
        throw new ProvenInfrastructureError("Provider refused before create", "omp", 10_000);
      },
    });
    const admission = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence("retry-deadline", { deadlineAt: START + 5_000 }),
    );
    const run = await observed(h, admission, "failed");
    expect(run).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      agentCreationStatus: "unknown",
    });
    expect(run.managed?.reservation).toBe(false);
    expect(run.managed?.attempts).toHaveLength(1);
    now += 20_000;
    await h.coordinator.pump();
    expect(h.launches).toHaveLength(1);
  });

  it("never resets the three-attempt budget when reopening between retries", async () => {
    const launch = async () => {
      throw new ProvenInfrastructureError("No agent created", "omp");
    };
    const first = await harness({ launch });
    const run = await retryAt(
      first,
      await first.coordinator.admitPrepared(makePrepared(), occurrence("three-attempts")),
      START + 2_250,
    );
    expect(run.managed?.notBefore).toBe(START + 2_250);
    await close(first);
    now = START + 2_250;
    const second = await harness({ launch });
    const retried = await retryAt(second, run, START + 10_500);
    expect(retried.managed?.notBefore).toBe(START + 10_500);
    await close(second);
    now = START + 10_500;
    const third = await harness({ launch });
    const exhausted = await observed(third, run, "failed");
    expect(exhausted.executionStatus).toBe("failed");
    expect(exhausted.managed?.attempts).toHaveLength(3);
    expect(exhausted.managed?.reservation).toBe(false);
    now += 60_000;
    await third.coordinator.pump();
    expect(first.launches.length + second.launches.length + third.launches.length).toBe(3);
  });

  it("releases a typed unsupported-identity failure without scheduling transient retries", async () => {
    const h = await harness({
      launch: async () => {
        throw new HostCapabilityError("managed-identity");
      },
    });
    const run = await observed(
      h,
      await h.coordinator.admitPrepared(makePrepared(), occurrence("unsupported")),
      "failed",
    );
    expect(run).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      agentCreationStatus: "not_created",
    });
    expect(run.managed?.reservation).toBe(false);
    expect(run.managed?.attempts).toHaveLength(1);
    await close(h);
    now += 60_000;
    const reopened = await harness();
    expect((await runOf(reopened, run.id)).executionStatus).toBe("failed");
    expect(h.launches.length + reopened.launches.length).toBe(1);
  });
});
