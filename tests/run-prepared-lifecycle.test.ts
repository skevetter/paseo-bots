import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { RunArtifacts } from "../server/run-artifacts";
import { type CoordinatorOptions, type PreparedAdmission, RunCoordinator } from "../server/run-coordinator";
import { RunStore } from "../server/run-store";
import { launchPreparedBotChat, type PreparedBotChat, PreparedLaunchNotCreatedError } from "../shared/chat";
import { HostCapabilityError } from "../shared/host-capability";
import { makePrepared } from "./coordinator-fixture";
import { connectFakeDaemon } from "./fake-daemon";
import { defined, type FakeHost, fakeHost, makeBot } from "./helpers";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
let directory: string;
let coordinators: RunCoordinator[];

type HostCallResult = { kind: "returned" } | { kind: "rejected"; error: unknown };

interface PreparedHarness {
  coordinator: RunCoordinator;
  store: RunStore;
  host: FakeHost;
  launches: PreparedBotChat[];
  hostCall: Promise<HostCallResult>;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-prepared-lifecycle-"));
  coordinators = [];
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.stop()));
  await rm(directory, { recursive: true, force: true });
});

async function harness(options: CoordinatorOptions = {}, attached = true): Promise<PreparedHarness> {
  const host = fakeHost([makeBot({ executionMode: "managed", provider: "omp", model: "frozen-model" })]);
  const store = new RunStore(join(directory, "routines.json"));
  const launches: PreparedBotChat[] = [];
  let settleHostCall: ((result: HostCallResult) => void) | undefined;
  const hostCall = new Promise<HostCallResult>((resolve) => {
    settleHostCall = resolve;
  });
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => NOW,
    jitter: () => 0,
    reconcileIntervalMs: 60_000,
    refresh: async (_relay, prepared) => prepared,
    ...options,
    store,
    launch: async (launchHost, relay, prepared, observer) => {
      launches.push(structuredClone(prepared));
      try {
        const agentId = options.launch
          ? await options.launch(launchHost, relay, prepared, observer)
          : prepared.agentId;
        defined(settleHostCall)({ kind: "returned" });
        return agentId;
      } catch (error) {
        defined(settleHostCall)({ kind: "rejected", error });
        throw error;
      }
    },
  });
  coordinators.push(coordinator);
  if (attached) {
    const api = {
      agents: { ref: () => ({ refresh: async () => null }) },
    } as unknown as PaseoApi;
    const recovery = vi.spyOn(coordinator, "recover");
    host.attach(api);
    await defined(recovery.mock.results[0]).value;
    recovery.mockRestore();
  }
  return { coordinator, store, host, launches, hostCall };
}

async function close(h: PreparedHarness) {
  await h.coordinator.stop();
  coordinators.splice(coordinators.indexOf(h.coordinator), 1);
}

async function admit(h: PreparedHarness, plan: PreparedBotChat, patch: Partial<PreparedAdmission> = {}) {
  return h.coordinator.admitPrepared(plan, {
    trigger: "manual",
    due: new Date(NOW),
    requestId: "prepared-request",
    deferLaunch: true,
    ...patch,
  });
}

describe("durable deferred preparation", () => {
  it("retains a non-launchable frozen plan through pump and a cold coordinator reopen", async () => {
    const h = await harness();
    const plan = makePrepared();
    const run = await admit(h, plan);
    await h.coordinator.pump();
    expect(run.executionStatus).toBe("queued");
    expect(run.managed?.launchIntent).toBe(false);
    expect(run.managed?.reservation).toBe(false);
    expect(run.managed?.hostCreatedAt).toBeUndefined();
    expect(h.launches).toHaveLength(0);
    const frozen = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
      defined(run.managed).artifact,
    );
    expect(frozen.prepared.config).toEqual(plan.config);
    expect(frozen.prepared.agentId).toBe(plan.agentId);
    await close(h);
    const reopened = await harness();
    const recovered = defined(await reopened.coordinator.get(run.id));
    expect(recovered.executionStatus).toBe("queued");
    expect(recovered.managed?.launchIntent).toBe(false);
    expect(reopened.launches).toHaveLength(0);
    const waiting = await reopened.coordinator.waitForCreation(run.id, { timeoutMs: 0 });
    expect(waiting.status).toBe("pending");
    expect(waiting.run.agentId).toBe(plan.agentId);
    expect(waiting.run.managed?.hostCreatedAt).toBeUndefined();
  });

  it("durably records explicit start while detached and launches once after restart attachment", async () => {
    const h = await harness({}, false);
    const plan = makePrepared();
    const run = await admit(h, plan);
    const started = await h.coordinator.startPrepared(run.id);
    expect(started.executionStatus).toBe("queued");
    expect(started.managed?.launchIntent).toBe(true);
    expect(h.launches).toHaveLength(0);
    const disk = await new RunStore(h.store.path).read();
    expect(disk.routines["chat:bot-1"]?.runs[0]?.managed?.launchIntent).toBe(true);
    await close(h);
    const reopened = await harness();
    const host = await reopened.hostCall;
    if (host.kind === "rejected") throw host.error;
    const created = await reopened.coordinator.waitForCreation(run.id, { timeoutMs: 5_000 });
    expect(created.status).toBe("created");
    expect(created.run.managed?.hostCreatedAt).toBe(NOW);
    expect(reopened.launches.map((launch) => [launch.agentId, launch.idempotencyKey])).toEqual([
      [plan.agentId, plan.idempotencyKey],
    ]);
    await reopened.coordinator.startPrepared(run.id);
    await reopened.coordinator.pump();
    expect(reopened.launches).toHaveLength(1);
  });
});

describe("explicit prepared start", () => {
  it("commits intent and its artifact before an idempotent concurrent start can call the host", async () => {
    let acknowledge: (() => void) | undefined;
    const acknowledgement = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        const disk = await new RunStore(join(directory, "routines.json")).read();
        const saved = defined(disk.routines["chat:bot-1"]?.runs[0]);
        expect(saved.executionStatus).toBe("starting");
        expect(saved.managed?.launchIntent).toBe(true);
        expect(saved.managed?.reservation).toBe(true);
        expect(saved.managed?.hostCreatedAt).toBeUndefined();
        const artifact = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
          defined(saved.managed).artifact,
        );
        expect(artifact.prepared).toEqual(plan);
        await acknowledgement;
        return plan.agentId;
      },
    });
    const plan = makePrepared();
    const run = await admit(h, plan);
    const waiting = h.coordinator.waitForCreation(run.id, { timeoutMs: 10_000 });
    try {
      const [first, replay] = await Promise.all([
        h.coordinator.startPrepared(run.id),
        h.coordinator.startPrepared(run.id),
      ]);
      expect([first.id, replay.id]).toEqual([run.id, run.id]);
      expect(first.managed?.launchIntent).toBe(true);
      expect(first.managed?.reservation).toBe(true);
      expect((await h.coordinator.waitForCreation(run.id, { timeoutMs: 0 })).status).toBe("pending");
    } finally {
      defined(acknowledge)();
    }
    const host = await h.hostCall;
    if (host.kind === "rejected") throw host.error;
    const receipt = await waiting;
    expect(receipt.status).toBe("created");
    if (receipt.status !== "created") throw new Error("Expected host-confirmed creation");
    expect(receipt.agentId).toBe(plan.agentId);
    expect(receipt.run.managed?.hostCreatedAt).toBe(NOW);
    expect((await h.coordinator.get(run.id))?.executionStatus).toBe("running");
    expect(h.launches).toHaveLength(1);
  });

  it("permanently cancels an unstarted plan instead of resurrecting it on start or restart", async () => {
    const h = await harness();
    const plan = makePrepared();
    const run = await admit(h, plan);
    await h.coordinator.cancel(run.id);
    const canceled = await h.coordinator.startPrepared(run.id);
    expect([canceled.executionStatus, canceled.taskOutcome, canceled.agentCreationStatus]).toEqual([
      "canceled",
      "unknown",
      "not_created",
    ]);
    expect(canceled.managed?.launchIntent).toBe(false);
    expect(canceled.managed?.reservation).toBe(false);
    expect(h.launches).toHaveLength(0);
    expect((await h.coordinator.waitForCreation(run.id, { timeoutMs: 0 })).status).toBe("not_created");
    await close(h);
    const reopened = await harness();
    await reopened.coordinator.startPrepared(run.id);
    expect(reopened.launches).toHaveLength(0);
    expect((await reopened.coordinator.get(run.id))?.executionStatus).toBe("canceled");
    expect((await reopened.coordinator.waitForCreation(run.id, { timeoutMs: 0 })).status).toBe("not_created");
  });
});

describe("immutable prepared metadata", () => {
  it("uses only the retained artifact after configuration changes and protects it from returned-object mutation", async () => {
    const h = await harness({}, false);
    const plan = makePrepared();
    plan.metadata.inputArtifactRefs = ["private-input-reference"];
    plan.metadata.playbooks = [{ id: "playbook-1", version: "revision-1", contentHash: "a".repeat(64) }];
    const frozen = structuredClone(plan.metadata);
    const run = await admit(h, plan);
    plan.metadata.resolvedPolicy.model.value = "changed-model";
    plan.metadata.inputArtifactRefs.push("later-reference");
    (await h.host.values()).bots = [];
    const snapshot = await h.coordinator.snapshot(run.id);
    expect(snapshot.status).toBe("available");
    if (snapshot.status !== "available") throw new Error("Expected retained admission metadata");
    expect(snapshot.metadata).toEqual(frozen);
    snapshot.metadata.resolvedPolicy.provider.value = "caller-mutation";
    snapshot.metadata.playbooks.splice(0);
    await close(h);
    const reopened = await harness({}, false);
    expect(await reopened.coordinator.snapshot(run.id)).toEqual({ status: "available", metadata: frozen });
  });

  it.each(["missing", "tampered"] as const)(
    "reports a %s artifact unavailable without mutable-policy fallback or host creation",
    async (failure) => {
      const h = await harness();
      const run = await admit(h, makePrepared());
      const artifactPath = join(directory, "run-artifacts", `${defined(run.managed).artifact.id}.json`);
      if (failure === "missing") await rm(artifactPath);
      else
        await writeFile(
          artifactPath,
          JSON.stringify({ prepared: makePrepared({ model: "tampered-model" }) }),
        );
      (await h.host.values()).bots[0] = makeBot({ executionMode: "managed", model: "new-current-model" });
      const unavailable = await h.coordinator.snapshot(run.id);
      expect(unavailable.status).toBe("unavailable");
      if (unavailable.status !== "unavailable") throw new Error("Expected unverifiable snapshot refusal");
      expect(unavailable.reason).toMatch(/artifact|verified/i);
      await expect(h.coordinator.startPrepared(run.id)).rejects.toThrow(/artifact|ENOENT/i);
      expect(h.launches).toHaveLength(0);
      const saved = defined(await h.coordinator.get(run.id));
      expect(saved.executionStatus).toBe("queued");
      expect(saved.managed?.reservation).toBe(false);
      await close(h);
      const reopened = await harness({}, false);
      expect((await reopened.coordinator.snapshot(run.id)).status).toBe("unavailable");
    },
  );
});

describe("creation evidence boundary", () => {
  it("records rejected preparation and missed occurrences as unknown tasks with no agent", async () => {
    const h = await harness({
      prepare: async () => {
        throw new Error("Cannot inspect launch configuration");
      },
    });
    const state = await h.host.values();
    const failed = await h.coordinator.admit({
      bot: defined(state.bots[0]),
      state,
      trigger: "manual",
      due: new Date(NOW),
      requestId: "failed-inspection",
      prompt: "Inspect the inbox",
    });
    expect(failed).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      agentCreationStatus: "not_created",
      agentId: null,
    });
    expect((await h.coordinator.waitForCreation(failed.id, { timeoutMs: 0 })).status).toBe("not_created");
    const missed = await h.coordinator.recordMissed("missed-routine", new Date(NOW - 60_000), new Date(NOW));
    expect(missed).toMatchObject({
      executionStatus: "canceled",
      taskOutcome: "unknown",
      agentCreationStatus: "not_created",
      agentId: null,
      skipped: "missed",
    });
    expect(h.launches).toEqual([]);
  });

  it("does not downgrade authentic creation after a later ambiguous or negative launch error", async () => {
    const h = await harness({
      launch: async (_host, _relay, plan, observer) => {
        observer?.onEvent?.({
          kind: "agent",
          idempotencyKey: plan.idempotencyKey,
          revision: 1,
          phase: "agent_ready",
          agentId: plan.agentId,
          workspaceId: "workspace-1",
          error: null,
        });
        observer?.onEvent?.({
          kind: "agent",
          idempotencyKey: plan.idempotencyKey,
          revision: 2,
          phase: "failed",
          agentId: null,
          workspaceId: null,
          error: "Lost later progress",
          outcomeUnknown: true,
        });
        throw new PreparedLaunchNotCreatedError("Later adapter failure is not stronger than a creation ACK");
      },
    });
    const run = await admit(h, makePrepared());
    await h.coordinator.startPrepared(run.id);
    const receipt = await h.coordinator.waitForCreation(run.id, { timeoutMs: 5_000 });
    expect(receipt.status).toBe("created");
    expect(receipt.run).toMatchObject({
      executionStatus: "unknown",
      taskOutcome: "unknown",
      agentCreationStatus: "created",
      managed: { reservation: true, hostCreatedAt: NOW },
    });
  });

  it("releases a failed workspace launch without claiming semantic no-work and admits the next request", async () => {
    const daemon = await connectFakeDaemon({ creationLifecycle: true, agentRequestReceipts: true });
    try {
      vi.spyOn(daemon.api.workspaces, "list").mockRejectedValueOnce(new Error("Workspace unavailable"));
      const h = await harness({
        launch: async (_host, _relay, plan, observer) => launchPreparedBotChat(daemon.api, plan, observer),
      });
      const plan = makePrepared({ botName: "Inbox", placement: { path: "/work", projectRoot: null } });
      const run = await admit(h, plan);
      await h.coordinator.startPrepared(run.id);
      const failed = await h.coordinator.waitForCreation(run.id, { timeoutMs: 5_000 });
      expect(failed.status).toBe("not_created");
      expect(failed.run).toMatchObject({
        executionStatus: "failed",
        taskOutcome: "unknown",
        agentCreationStatus: "not_created",
        managed: { reservation: false, launchIntent: false },
      });
      expect(daemon.sent.filter((frame) => frame.type === "agent.create.request")).toEqual([]);
      const next = await admit(
        h,
        makePrepared({
          botName: "Inbox",
          placement: { path: "/work", projectRoot: null },
        }),
        { requestId: "next-workspace-request" },
      );
      await h.coordinator.startPrepared(next.id);
      const created = await h.coordinator.waitForCreation(next.id, { timeoutMs: 5_000 });
      expect(created.status).toBe("created");
      expect(created.run.agentCreationStatus).toBe("created");
      expect(
        daemon.sent.filter((frame) => frame.type === "agent.create.request").map((frame) => frame.agentId),
      ).toEqual([next.agentId]);
      const reopened = await new RunStore(h.store.path).get(run.id);
      expect(reopened?.taskOutcome).toBe("unknown");
      expect(reopened?.agentCreationStatus).toBe("not_created");
    } finally {
      await daemon.close();
    }
  });

  it("bounds a wait for a queued UUID without reporting it as host-created", async () => {
    const h = await harness({}, false);
    const plan = makePrepared();
    const run = await admit(h, plan);
    const before = await readFile(h.store.path);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const waiting = h.coordinator.waitForCreation(run.id, { timeoutMs: 25 });
      await vi.advanceTimersByTimeAsync(25);
      const result = await waiting;
      expect(result.status).toBe("pending");
      expect(result.run.agentId).toBe(plan.agentId);
      expect(result.run.managed?.hostCreatedAt).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    expect(await readFile(h.store.path)).toEqual(before);
  });

  it("keeps transport ambiguity pending through unsupported cancellation rather than claiming no creation", async () => {
    const h = await harness({
      launch: async () => {
        throw new Error("Transport lost before creation acknowledgement");
      },
    });
    const run = await admit(h, makePrepared());
    await h.coordinator.startPrepared(run.id);
    expect((await h.hostCall).kind).toBe("rejected");
    await vi.waitFor(
      async () => {
        expect((await h.coordinator.get(run.id))?.executionStatus).toBe("unknown");
      },
      { timeout: 5_000, interval: 10 },
    );
    const started = defined(await h.coordinator.get(run.id));
    expect(started.executionStatus).toBe("unknown");
    expect(started.managed?.reservation).toBe(true);
    expect(started.managed?.hostCreatedAt).toBeUndefined();
    const canceled = await h.coordinator.cancel(run.id);
    expect(canceled.error).toContain("does not expose active cancellation");
    expect(canceled.run.managed?.reservation).toBe(true);
    const receipt = await h.coordinator.waitForCreation(run.id, { timeoutMs: 0 });
    expect(receipt.status).toBe("pending");
    expect(receipt.run.taskOutcome).toBe("unknown");
    await close(h);
    const reopened = await harness({}, false);
    expect((await reopened.coordinator.waitForCreation(run.id, { timeoutMs: 0 })).status).toBe("pending");
    expect(reopened.launches).toHaveLength(0);
  });

  it("reports a proven unsupported host as not created without retrying", async () => {
    const h = await harness({
      launch: async () => {
        throw new HostCapabilityError("managed-identity");
      },
    });
    const run = await admit(h, makePrepared());
    await h.coordinator.startPrepared(run.id);
    const receipt = await h.coordinator.waitForCreation(run.id, { timeoutMs: 5_000 });
    expect(receipt.status).toBe("not_created");
    const failed = defined(await h.coordinator.get(run.id));
    expect([failed.executionStatus, failed.taskOutcome, failed.agentCreationStatus]).toEqual([
      "failed",
      "unknown",
      "not_created",
    ]);
    expect(failed.managed?.reservation).toBe(false);
    expect(h.launches).toHaveLength(1);
    await h.coordinator.pump();
    expect(h.launches).toHaveLength(1);
  });
});
