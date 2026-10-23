/// <reference lib="es2024.promise" />

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { ProvenInfrastructureError } from "../server/run-admission-policy";
import { type RunArtifactRef, RunArtifacts } from "../server/run-artifacts";
import {
  type CoordinatorOptions,
  type ExecutionEnd,
  type ManagedSessionOpening,
  RunCoordinator,
} from "../server/run-coordinator";
import { BoundedHostCalls } from "../server/run-deadlines";
import { emptyRecord, type RunSnapshot, RunStore } from "../server/run-store";
import type { PreparedBotChat } from "../shared/chat";
import type { RoutineRun } from "../shared/rpc";
import type { SessionEpoch } from "../shared/runs";
import { makePrepared } from "./coordinator-fixture";
import { defined, fakeHost, makeBot, makeRun } from "./helpers";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
let directory: string;
let coordinators: RunCoordinator[];
let releases: (() => void)[];
let fixture = 0;

function gate() {
  const barrier = Promise.withResolvers<void>();
  releases.push(() => barrier.resolve());
  return barrier;
}

/** Observe committed real metadata, not host-call return timing or a mocked writer. */
class ObservedStore extends RunStore {
  private readonly observers = new Set<(state: RunSnapshot) => void>();
  afterCommit?: (state: RunSnapshot) => Promise<void>;

  next(predicate: (state: RunSnapshot) => boolean): Promise<RunSnapshot> {
    const { promise, resolve } = Promise.withResolvers<RunSnapshot>();
    const observe = (state: RunSnapshot) => {
      if (!predicate(state)) return;
      this.observers.delete(observe);
      resolve(state);
    };
    this.observers.add(observe);
    return promise;
  }

  override async updateState<T>(change: (state: RunSnapshot) => T | Promise<T>): Promise<T> {
    const result = await super.updateState(change);
    const state = await super.read();
    for (const observe of this.observers) observe(state);
    await this.afterCommit?.(state);
    return result;
  }
}

interface Harness {
  coordinator: RunCoordinator;
  store: ObservedStore;
  clock: { now: number };
  launches: PreparedBotChat[];
  called: PromiseWithResolvers<PreparedBotChat>;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-lifecycle-fences-"));
  coordinators = [];
  releases = [];
});

afterEach(async () => {
  for (const release of releases) release();
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.stop()));
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function harness(options: CoordinatorOptions = {}): Promise<Harness> {
  const host = fakeHost(
    ["bot-1", "bot-2"].map((id) =>
      makeBot({
        id,
        executionMode: "managed",
        provider: "omp",
        model: "frozen-model",
      }),
    ),
  );
  const store = new ObservedStore(join(directory, `fixture-${++fixture}`, "routines.json"));
  await store.initialize();
  const clock = { now: NOW };
  const called = Promise.withResolvers<PreparedBotChat>();
  const launches: PreparedBotChat[] = [];
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => clock.now,
    jitter: () => 0,
    launchTimeoutMs: 60_000,
    reconcileIntervalMs: 60_000,
    refresh: async (_relay, prepared) => prepared,
    cancel: async () => {
      throw new Error("Cancellation acknowledgement unavailable");
    },
    ...options,
    store,
    launch: async (launchHost, relay, prepared, observer) => {
      launches.push(structuredClone(prepared));
      called.resolve(prepared);
      return options.launch ? options.launch(launchHost, relay, prepared, observer) : prepared.agentId;
    },
  });
  coordinators.push(coordinator);
  host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi);
  await coordinator.ready();
  return { coordinator, store, clock, launches, called };
}

function opening(plan: PreparedBotChat, patch: Partial<ManagedSessionOpening> = {}): ManagedSessionOpening {
  return {
    agentId: plan.agentId,
    workspaceId: "workspace-1",
    provider: plan.provider,
    cwd: plan.placement.path,
    reason: "create",
    purpose: "interactive",
    ...patch,
  };
}

async function prepare(h: Harness, botId = "bot-1") {
  const plan = makePrepared({ botId, placement: { path: join(directory, botId), projectRoot: null } });
  const run = await h.coordinator.admitPrepared(plan, {
    trigger: "manual",
    due: new Date(h.clock.now),
    requestId: plan.idempotencyKey,
    deferLaunch: true,
  });
  return { plan, run };
}

async function activeSession(h: Harness, botId = "bot-1", activateResume = true) {
  const { plan, run } = await prepare(h, botId);
  const starting = h.coordinator.startPrepared(run.id);
  await h.called.promise;
  const receipt = await h.coordinator.waitForCreation(run.id, { timeoutMs: 10_000 });
  expect(receipt.status).toBe("created");
  await starting;
  const first = defined(await h.coordinator.sessionOpened(opening(plan)));
  await h.coordinator.sessionActive(plan.agentId);
  const resumed = defined(await h.coordinator.sessionOpened(opening(plan, { reason: "resume" })));
  if (activateResume) await h.coordinator.sessionActive(plan.agentId);
  return { plan, run, first, resumed };
}

function stored(state: RunSnapshot, id: string): RoutineRun {
  return defined(
    Object.values(state.routines)
      .flatMap((record) => record.runs)
      .find((run) => run.id === id),
  );
}

async function assertStoppedBeforeCreate() {
  const h = await harness();
  const { plan, run } = await prepare(h);
  const entered = gate();
  const unblock = gate();
  h.store.afterCommit = async (state) => {
    if (stored(state, run.id).executionStatus !== "starting") return;
    h.store.afterCommit = undefined;
    entered.resolve();
    await unblock.promise;
  };
  const starting = h.coordinator.startPrepared(run.id).catch((error: unknown) => error);
  await entered.promise;
  const stopping = h.coordinator.stop();
  unblock.resolve();
  await Promise.all([starting, stopping]);
  expect.soft(h.launches.map((launch) => launch.agentId)).toEqual([]);
  const after = stored(await h.store.read(), run.id);
  expect.soft(after.managed?.hostCreatedAt).toBeUndefined();
  expect.soft(after.agentId).toBe(plan.agentId);
}

async function assertClosedSessionCallbacks() {
  const h = await harness();
  const { plan, resumed, run } = await activeSession(h, "bot-1", false);
  const before = await readFile(h.store.path);
  const entered = gate();
  const unblock = gate();
  const read = RunArtifacts.prototype.get;
  vi.spyOn(RunArtifacts.prototype, "get").mockImplementation(async function <T>(
    this: RunArtifacts,
    ref: RunArtifactRef,
  ): Promise<T> {
    const value = (await read.call(this, ref)) as T;
    entered.resolve();
    await unblock.promise;
    return value;
  });
  const pending = h.coordinator.sessionOpened(opening(plan, { reason: "refresh" })).then(
    (receipt) => ({ receipt, error: null }),
    (error: unknown) => ({ receipt: null, error }),
  );
  await entered.promise;
  const stopping = h.coordinator.stop();
  unblock.resolve();
  const [outcome] = await Promise.all([pending, stopping]);
  expect.soft(outcome.error).toBeInstanceOf(Error);
  expect.soft(outcome.receipt).toBeNull();
  await h.coordinator.sessionActive(plan.agentId).catch(() => {});
  const end: ExecutionEnd & { sessionEpoch: SessionEpoch } = {
    kind: "completed",
    executionId: run.executionId,
    sessionEpoch: resumed.sessionEpoch,
    reply: "late reply",
  };
  await h.coordinator.finished(plan.agentId, end).catch(() => {});
  expect.soft(await readFile(h.store.path)).toEqual(before);
  expect.soft((await h.store.read()).coordinator.sessions[plan.agentId]?.at(-1)?.state).toBe("pending");
  vi.restoreAllMocks();
}

describe("managed lifecycle fences", () => {
  it("keeps cancellation final when a pending create later proves a matching no-effect failure", async () => {
    const unblock = gate();
    const h = await harness({
      launch: async () => {
        await unblock.promise;
        throw new ProvenInfrastructureError("Provider proved create had no effect", "omp");
      },
    });
    const { run, plan } = await prepare(h);
    const starting = h.coordinator.startPrepared(run.id).catch((error: unknown) => error);
    await h.called.promise;
    await h.coordinator.cancel(run.id);
    const settled = h.store.next((state) => {
      const current = stored(state, run.id);
      return !!current.managed?.cancelRequested && current.executionStatus !== "starting";
    });
    unblock.resolve();
    const saved = stored(await settled, run.id);
    await starting;
    expect.soft([saved.executionStatus, saved.taskOutcome]).toEqual(["canceled", "no_change"]);
    expect.soft(saved.managed?.reservation).toBe(false);
    expect.soft(saved.agentId).toBe(plan.agentId);
    expect.soft(saved.executionId).toBe(run.executionId);
    expect.soft(saved.managed?.attempts.map((attempt) => attempt.agentId)).toEqual([plan.agentId]);
    h.clock.now += 10_000;
    await h.coordinator.pump();
    expect.soft(h.launches.map((launch) => launch.agentId)).toEqual([plan.agentId]);
  });

  it("does not settle a resumed generation from stale or generation-less completion evidence", async () => {
    const h = await harness();
    const first = await activeSession(h);
    const observed: ExecutionEnd & { sessionEpoch: SessionEpoch } = {
      kind: "completed",
      executionId: first.run.executionId,
      sessionEpoch: first.first.sessionEpoch,
      turnId: "reused-turn",
      reply: "Reply observed during generation one",
    };
    await h.coordinator.finished(first.plan.agentId, observed);
    const afterStale = defined(await h.coordinator.get(first.run.id));
    expect.soft(afterStale.sessionEpoch).toBe(first.resumed.sessionEpoch);
    expect.soft(afterStale.executionStatus).not.toBe("completed");
    expect.soft(afterStale.managed?.reservation).toBe(true);
    expect.soft(afterStale.managed?.result).toBeUndefined();
    expect.soft(afterStale.output).toBeNull();
    if (afterStale.managed?.result) {
      const evidence = await new RunArtifacts(dirname(h.store.path)).get<{ sessionEpoch: number }>(
        afterStale.managed.result,
      );
      expect.soft(evidence.sessionEpoch).not.toBe(first.resumed.sessionEpoch);
    }
    const second = await activeSession(h, "bot-2");
    await h.coordinator.finished(second.plan.agentId, {
      kind: "completed",
      executionId: second.run.executionId,
      turnId: "reused-turn",
      reply: "No observed generation",
    });
    const afterMissing = defined(await h.coordinator.get(second.run.id));
    expect.soft(afterMissing.sessionEpoch).toBe(second.resumed.sessionEpoch);
    expect.soft(afterMissing.executionStatus).toBe("unknown");
    expect.soft(afterMissing.managed?.reservation).toBe(true);
    expect.soft(afterMissing.output).toBeNull();
  });
});

describe("terminal execution and shutdown ownership fences", () => {
  it("requires a new plan before interactive reopening of every terminal managed execution", async () => {
    for (const kind of ["completed", "failed", "canceled"] as const) {
      const h = await harness();
      const { plan, run, resumed } = await activeSession(h);
      const end: ExecutionEnd & { sessionEpoch: SessionEpoch } = {
        kind,
        executionId: run.executionId,
        sessionEpoch: resumed.sessionEpoch,
        reply: `${kind} generation two`,
      };
      await h.coordinator.finished(plan.agentId, end);
      const before = await readFile(h.store.path);
      expect(
        await h.coordinator.sessionOpened(opening(plan, { purpose: "history", reason: "refresh" })),
      ).toBeNull();
      expect(await readFile(h.store.path)).toEqual(before);
      await expect
        .soft(h.coordinator.sessionOpened(opening(plan, { reason: "resume" })))
        .rejects.toThrow(/new.*plan|new.*admission|terminal/i);
      const legacy = makeRun(`legacy-${kind}`, { agentId: `${plan.agentId}-legacy` });
      await h.store.updateState(({ routines, coordinator }) => {
        routines.legacy = { ...emptyRecord(), runs: [legacy] };
        coordinator.occurrences[legacy.occurrenceKey] = legacy.id;
      });
      const legacyBytes = await readFile(h.store.path);
      expect(
        await h.coordinator.sessionOpened(
          opening(plan, { agentId: defined(legacy.agentId), reason: "resume" }),
        ),
      ).toBeNull();
      expect(await readFile(h.store.path)).toEqual(legacyBytes);
    }
  });

  it("closes launch and callback fences permanently before releasing coordinator ownership", async () => {
    await assertStoppedBeforeCreate();
    await assertClosedSessionCallbacks();
    const calls = new BoundedHostCalls(10_000);
    const invoked: string[] = [];
    const create = async () => {
      invoked.push("unexpected host create");
      return "late-create";
    };
    calls.close();
    await expect.soft(calls.run(create, "post-stop create")).rejects.toThrow(/stopp|clos/i);
    calls.close();
    await expect.soft(calls.run(create, "second post-stop create")).rejects.toThrow(/stopp|clos/i);
    expect(invoked).toEqual([]);
  });
});
