import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { ProvenInfrastructureError } from "../server/run-admission-policy";
import { type RunArtifactRef, RunArtifacts } from "../server/run-artifacts";
import { type CoordinatorOptions, type PreparedAdmission, RunCoordinator } from "../server/run-coordinator";
import type { HostAgentEvidence, HostTimelineEvidence } from "../server/run-host-evidence";
import { type RunSnapshot, RunStore } from "../server/run-store";
import type { PreparedBotChat } from "../shared/chat";
import { EXECUTION_LABEL, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { makePrepared } from "./coordinator-fixture";
import { defined, type FakeHost, fakeHost, makeBot } from "./helpers";

const START = Date.parse("2026-10-23T10:00:00.000Z");
const UNBOUNDED = { global: 20, perProvider: 20, perBot: 20, perResource: 20 };
let directory: string;
let now: number;
let coordinators: RunCoordinator[];

type AgentEvidence = { agent: HostAgentEvidence; timeline: HostTimelineEvidence };
interface Harness {
  coordinator: RunCoordinator;
  store: RunStore;
  host: FakeHost;
  api: PaseoApi;
  launches: PreparedBotChat[];
  agents: Map<string, AgentEvidence>;
}

interface WriteFault {
  stage: "queued" | "reserved" | "starting" | "running";
  boundary: "before" | "after";
}

class InterruptedStore extends RunStore {
  private interrupted = false;

  constructor(
    path: string,
    private readonly fault: WriteFault,
  ) {
    super(path);
  }

  override async updateState<T>(change: (state: RunSnapshot) => T | Promise<T>): Promise<T> {
    if (this.interrupted) throw new Error("Injected process interruption");
    let reached = false;
    const result = await super.updateState(async (state) => {
      const value = await change(state);
      reached = Object.values(state.routines).some((record) =>
        record.runs.some((run) => run.executionStatus === this.fault.stage),
      );
      if (reached && this.fault.boundary === "before") this.interrupt();
      return value;
    });
    if (reached && this.fault.boundary === "after") this.interrupt();
    return result;
  }

  private interrupt(): never {
    this.interrupted = true;
    throw new Error("Injected process interruption");
  }
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-run-coordinator-"));
  now = START;
  coordinators = [];
});

afterEach(async () => {
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.stop()));
  await rm(directory, { recursive: true, force: true });
});

function occurrence(patch: Partial<PreparedAdmission> = {}): PreparedAdmission {
  return {
    routineId: "routine-1",
    trigger: "schedule",
    due: new Date(START),
    requestId: "request-1",
    ...patch,
  };
}

function hostEvidence(prepared: PreparedBotChat): AgentEvidence {
  return {
    agent: {
      id: prepared.agentId,
      status: "running",
      labels: { ...prepared.labels },
      pendingPermissions: [],
      activeTurn: { turnId: "reused-turn" },
    },
    timeline: {
      endCursor: { epoch: "host-session", seq: 1 },
      error: null,
      gap: false,
      staleCursor: false,
      hasNewer: false,
      entries: [
        {
          seqEnd: 1,
          item: { type: "user_message", clientMessageId: prepared.clientMessageId, text: prepared.prompt },
        },
      ],
    },
  };
}

async function harness(
  options: CoordinatorOptions = {},
  attached = true,
  agents = new Map<string, AgentEvidence>(),
): Promise<Harness> {
  const host = fakeHost([makeBot({ provider: "omp", model: "frozen-model" })]);
  const api = {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const found = agents.get(id);
          return found ? { agent: found.agent } : null;
        },
        timeline: { refetch: async () => defined(agents.get(id)).timeline },
      }),
    },
  } as unknown as PaseoApi;
  const launches: PreparedBotChat[] = [];
  const launch: NonNullable<CoordinatorOptions["launch"]> = async (hostArg, relay, prepared, observer) => {
    launches.push(structuredClone(prepared));
    const id = options.launch ? await options.launch(hostArg, relay, prepared, observer) : prepared.agentId;
    agents.set(id, hostEvidence(prepared));
    return id;
  };
  const store = options.store ?? new RunStore(join(directory, "routines.json"));
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => now,
    jitter: () => 0.25,
    capacity: UNBOUNDED,
    refresh: async (_relay, prepared) => prepared,
    ...options,
    store,
    launch,
  });
  coordinators.push(coordinator);
  if (attached) {
    const recovery = vi.spyOn(coordinator, "recover");
    host.attach(api);
    await defined(recovery.mock.results[0]).value;
    recovery.mockRestore();
  }
  return { coordinator, store, host, api, launches, agents };
}

async function close(h: Harness) {
  await h.coordinator.stop();
  coordinators.splice(coordinators.indexOf(h.coordinator), 1);
}

async function runOf(h: Harness, id: string) {
  return defined(await h.coordinator.get(id));
}

async function complete(h: Harness, run: RoutineRun, turnId: string | null = null) {
  return h.coordinator.finished(defined(run.agentId), {
    kind: "completed",
    turnId,
    executionId: run.executionId,
  });
}

async function changeCrashWindow(h: Harness, run: RoutineRun, status: "reserved" | "starting" | "running") {
  await h.store.updateState(({ routines }) => {
    const saved = defined(defined(routines["routine-1"]).runs.find((entry) => entry.id === run.id));
    saved.executionStatus = status;
    defined(saved.managed).reservation = true;
  });
}

describe("durable admission identity", () => {
  it("publishes private launch artifact and durable UUID reservation before the host call", async () => {
    const h = await harness({
      launch: async (_host, _relay, prepared) => {
        const disk = await new RunStore(join(directory, "routines.json")).read();
        const saved = defined(defined(disk.routines["routine-1"]).runs[0]);
        const managed = defined(saved.managed);
        expect(saved.executionStatus).toBe("starting");
        expect(managed.reservation).toBe(true);
        expect(saved.agentId).toBe(prepared.agentId);
        expect(prepared.agentId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
        expect(managed.attempts[0]?.idempotencyKey).toBe(prepared.idempotencyKey);
        expect(disk.coordinator.occurrences[saved.occurrenceKey]).toBe(saved.id);
        const artifact = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
          managed.artifact,
        );
        expect(artifact.prepared).toEqual(prepared);
        const mode = (await stat(join(directory, "run-artifacts", `${managed.artifact.id}.json`))).mode;
        expect(mode & 0o777).toBe(0o600);
        expect(await readFile(join(directory, "routines.json"), "utf8")).not.toContain("relay-secret");
        return prepared.agentId;
      },
    });
    const prepared = makePrepared();
    prepared.config.systemPrompt += " relay-secret";
    const run = await h.coordinator.admitPrepared(prepared, occurrence());
    expect(run.executionStatus).toBe("running");
    expect(h.launches).toHaveLength(1);
  });

  it.each(["schedule", "manual", "webhook"] as const)(
    "deduplicates concurrent %s admission and after reopening",
    async (trigger) => {
      const h = await harness();
      const input = occurrence({ trigger });
      const replay =
        trigger === "schedule"
          ? { ...input, requestId: "different-admission-request" }
          : { ...input, due: new Date(START + 60_000) };
      const [first, second] = await Promise.all([
        h.coordinator.admitPrepared(makePrepared(), input),
        h.coordinator.admitPrepared(makePrepared(), replay),
      ]);
      expect(second.id).toBe(first.id);
      expect(h.launches).toHaveLength(1);
      await close(h);
      const reopened = await harness({}, true, h.agents);
      const duplicate = await reopened.coordinator.admitPrepared(makePrepared(), replay);
      expect(duplicate.id).toBe(first.id);
      expect(reopened.launches).toHaveLength(0);
      expect((await reopened.coordinator.list()).runs.map((run) => run.id)).toEqual([first.id]);
    },
  );
});

describe("admission snapshot replay", () => {
  it("looks up a duplicate before preparation even after bot and policy deletion", async () => {
    const prepare = vi.fn<NonNullable<CoordinatorOptions["prepare"]>>(async () => makePrepared());
    const h = await harness({ prepare });
    const input = {
      bot: makeBot(),
      trigger: "manual" as const,
      due: new Date(START),
      requestId: "manual-once",
      title: "Review",
      prompt: "Review inbox",
    };
    const first = await h.coordinator.admit(input);
    (await h.host.values()).bots = [];
    prepare.mockRejectedValue(new Error("Deleted bot policy cannot be resolved"));
    const duplicate = await h.coordinator.admit(input);
    expect(duplicate.id).toBe(first.id);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(h.launches).toHaveLength(1);
  });

  it("replays the admitted config rather than mutable bot or policy values", async () => {
    const h = await harness({}, false);
    const prepared = makePrepared();
    const frozen = structuredClone(prepared);
    const queued = await h.coordinator.admitPrepared(prepared, occurrence());
    prepared.config.systemPrompt = "changed instructions";
    prepared.provider = "changed-provider";
    prepared.model = "changed-model";
    prepared.metadata.resolvedPolicy.provider.value = "changed-provider";
    (await h.host.values()).bots[0] = makeBot({ model: "new-default", soul: "edited" });
    expect(queued.executionStatus).toBe("queued");
    expect(h.coordinator.readiness).toBe("waiting_for_host_api");
    await close(h);
    const reopened = await harness();
    const launched = defined(reopened.launches[0]);
    expect(launched.config).toEqual(frozen.config);
    expect(launched.metadata).toEqual(frozen.metadata);
    expect([launched.provider, launched.model]).toEqual([frozen.provider, frozen.model]);
    expect((await runOf(reopened, queued.id)).executionStatus).toBe("running");
  });
});

describe("routine overlap admission", () => {
  it("queues overlap and launches it only after the active execution settles", async () => {
    const h = await harness();
    const first = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    const second = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ due: new Date(START + 1_000), overlap: "queue" }),
    );
    expect(second.executionStatus).toBe("queued");
    expect(second.managed?.reservation).toBe(false);
    await complete(h, first);
    expect((await runOf(h, second.id)).executionStatus).toBe("running");
    expect(h.launches).toHaveLength(2);
  });

  it("records skipped and coalesced occurrences without launching them", async () => {
    const h = await harness();
    const active = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    const skipped = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ due: new Date(START + 1_000), overlap: "skip" }),
    );
    const queued = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ due: new Date(START + 2_000), overlap: "coalesce" }),
    );
    const coalesced = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ due: new Date(START + 3_000), overlap: "coalesce" }),
    );
    expect([skipped.executionStatus, skipped.skipped, skipped.taskOutcome]).toEqual([
      "canceled",
      "busy",
      "no_change",
    ]);
    expect(queued.executionStatus).toBe("queued");
    expect(coalesced.managed?.coalescedInto).toBe(queued.id);
    expect(coalesced.executionStatus).toBe("canceled");
    await complete(h, active);
    expect(h.launches).toHaveLength(2);
    expect((await runOf(h, queued.id)).executionStatus).toBe("running");
    expect((await runOf(h, coalesced.id)).managed?.reservation).toBe(false);
  });
});

describe("resource capacity admission", () => {
  it.each([
    { dimension: "global", first: {}, next: { botId: "other", provider: "other" }, resources: [[], []] },
    { dimension: "perProvider", first: {}, next: { botId: "other" }, resources: [[], []] },
    { dimension: "perBot", first: {}, next: { provider: "other" }, resources: [[], []] },
    {
      dimension: "perResource",
      first: {},
      next: { botId: "other", provider: "other" },
      resources: [["opaque:shared"], ["opaque:shared"]],
    },
  ])(
    "enforces $dimension before host creation and frees it on completion",
    async ({ dimension, first, next, resources }) => {
      const h = await harness({ capacity: { ...UNBOUNDED, [dimension]: 1 } });
      const active = await h.coordinator.admitPrepared(
        makePrepared(first),
        occurrence({ resourceIds: resources[0] }),
      );
      const waiting = await h.coordinator.admitPrepared(
        makePrepared(next),
        occurrence({ routineId: "other-routine", requestId: "other-request", resourceIds: resources[1] }),
      );
      expect(waiting.executionStatus).toBe("queued");
      expect(waiting.managed?.reservation).toBe(false);
      expect(h.launches).toHaveLength(1);
      await complete(h, active);
      expect((await runOf(h, waiting.id)).executionStatus).toBe("running");
      expect(h.launches).toHaveLength(2);
    },
  );

  it("retains unknown effects against capacity instead of starting competing work", async () => {
    const h = await harness({
      capacity: { ...UNBOUNDED, global: 1 },
      launch: async () => {
        throw new Error("Transport lost after write");
      },
    });
    const unknown = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    const waiting = await h.coordinator.admitPrepared(
      makePrepared({ botId: "other" }),
      occurrence({ routineId: "other-routine" }),
    );
    expect(unknown.executionStatus).toBe("unknown");
    expect(unknown.managed?.reservation).toBe(true);
    expect(waiting.executionStatus).toBe("queued");
    now += 86_400_000;
    await h.coordinator.pump();
    await close(h);
    const reopened = await harness({ capacity: { ...UNBOUNDED, global: 1 } });
    expect((await runOf(reopened, unknown.id)).managed?.reservation).toBe(true);
    expect((await runOf(reopened, waiting.id)).executionStatus).toBe("queued");
    expect(reopened.launches).toHaveLength(0);
  });
});

describe("bounded infrastructure retry", () => {
  it("persists three distinct attempts at 2s and 8s plus jitter without re-resolving config", async () => {
    const h = await harness({
      launch: async () => {
        throw new ProvenInfrastructureError("No request accepted", "omp");
      },
    });
    const frozen = makePrepared();
    const run = await h.coordinator.admitPrepared(frozen, occurrence());
    expect(run.managed?.notBefore).toBe(START + 2_250);
    expect(run.managed?.reservation).toBe(false);
    now = START + 2_249;
    await h.coordinator.pump();
    expect(h.launches).toHaveLength(1);
    now += 1;
    await h.coordinator.pump();
    const second = await runOf(h, run.id);
    expect(second.managed?.notBefore).toBe(now + 8_250);
    now += 8_249;
    await h.coordinator.pump();
    expect(h.launches).toHaveLength(2);
    now += 1;
    await h.coordinator.pump();
    const terminal = await runOf(h, run.id);
    expect([terminal.executionStatus, terminal.taskOutcome]).toEqual(["failed", "no_change"]);
    expect(terminal.managed?.attempts.map((attempt) => attempt.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(new Set(h.launches.map((prepared) => prepared.agentId)).size).toBe(3);
    expect(new Set(h.launches.map((prepared) => prepared.idempotencyKey)).size).toBe(3);
    for (const prepared of h.launches) expect(prepared.config).toEqual(frozen.config);
    now += 1_000_000;
    await h.coordinator.pump();
    expect(h.launches).toHaveLength(3);
  });

  it("honors Retry-After durably across a coordinator reopen", async () => {
    const h = await harness({
      launch: async () => {
        throw new ProvenInfrastructureError("Provider unavailable", "omp", 20_000);
      },
    });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    expect(run.managed?.notBefore).toBe(START + 20_000);
    await close(h);
    now = START + 19_999;
    const reopened = await harness();
    expect(reopened.launches).toHaveLength(0);
    now += 1;
    await reopened.coordinator.pump();
    expect(reopened.launches).toHaveLength(1);
    expect((await runOf(reopened, run.id)).executionStatus).toBe("running");
  });

  it("persists an open provider circuit and allows unrelated providers", async () => {
    const h = await harness({
      launch: async () => {
        throw new ProvenInfrastructureError("No request accepted", "omp");
      },
    });
    await h.coordinator.admitPrepared(makePrepared(), occurrence());
    now += 2_250;
    await h.coordinator.pump();
    now += 8_250;
    await h.coordinator.pump();
    const circuit = defined((await new RunStore(h.store.path).read()).coordinator.circuits.omp);
    expect(circuit.failures).toBe(3);
    expect(circuit.openUntil).toBe(now + 30_000);
    await close(h);
    const reopened = await harness();
    const waiting = await reopened.coordinator.admitPrepared(
      makePrepared({ botId: "another" }),
      occurrence({ routineId: "another-routine" }),
    );
    const unrelated = await reopened.coordinator.admitPrepared(
      makePrepared({ provider: "other", botId: "third" }),
      occurrence({ routineId: "third-routine" }),
    );
    expect(waiting.executionStatus).toBe("queued");
    expect(unrelated.executionStatus).toBe("running");
    now = circuit.openUntil - 1;
    await reopened.coordinator.pump();
    expect((await runOf(reopened, waiting.id)).executionStatus).toBe("queued");
    now += 1;
    await reopened.coordinator.pump();
    expect((await runOf(reopened, waiting.id)).executionStatus).toBe("running");
    expect((await reopened.store.read()).coordinator.circuits.omp?.failures).toBe(0);
  });
});

describe("execution evidence identity", () => {
  it.each(["transport", "outcomeUnknown"] as const)(
    "does not retry an ambiguous %s creation",
    async (kind) => {
      const h = await harness({
        launch: async (_host, _relay, _prepared, observe) => {
          if (kind === "outcomeUnknown")
            observe?.({
              kind: "agent",
              idempotencyKey: "creation-1",
              revision: 1,
              phase: "failed",
              workspaceId: null,
              agentId: null,
              error: "transport lost",
              outcomeUnknown: true,
            });
          if (kind === "transport") throw new Error("Transport disconnected");
          throw new ProvenInfrastructureError("Host no longer proves absence", "omp");
        },
      });
      const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
      expect(run.executionStatus).toBe("unknown");
      expect(run.managed?.reservation).toBe(true);
      expect(run.managed?.attempts).toHaveLength(1);
      await close(h);
      now += 86_400_000;
      const reopened = await harness();
      await reopened.coordinator.reconcile(run.id);
      await reopened.coordinator.pump();
      expect((await runOf(reopened, run.id)).executionStatus).toBe("unknown");
      expect((await runOf(reopened, run.id)).managed?.reservation).toBe(true);
      expect(reopened.launches).toHaveLength(0);
    },
  );

  it.each([null, "repeated-turn"])(
    "settles only the agent and execution with provider turn %s",
    async (turnId) => {
      const h = await harness();
      const first = await h.coordinator.admitPrepared(makePrepared(), occurrence());
      const second = await h.coordinator.admitPrepared(
        makePrepared({ botId: "other" }),
        occurrence({ routineId: "other-routine" }),
      );
      await complete(h, first, turnId);
      await expect(
        h.coordinator.finished(defined(second.agentId), {
          kind: "completed",
          turnId,
          executionId: first.executionId,
        }),
      ).resolves.toBeNull();
      await complete(h, first, turnId);
      expect((await runOf(h, second.id)).executionStatus).toBe("running");
      expect((await runOf(h, second.id)).managed?.reservation).toBe(true);
      await complete(h, second, turnId);
      expect((await runOf(h, second.id)).executionStatus).toBe("completed");
      expect((await runOf(h, second.id)).taskOutcome).toBe("unknown");
    },
  );
});

describe("durable crash windows", () => {
  it.each(["queued", "reserved"] as const)(
    "resumes a durable %s crash window once, under its original identity",
    async (status) => {
      const h = await harness({}, false);
      const prepared = makePrepared();
      const run = await h.coordinator.admitPrepared(prepared, occurrence());
      if (status === "reserved") await changeCrashWindow(h, run, status);
      await close(h);
      const reopened = await harness();
      expect(reopened.launches.map((value) => value.agentId)).toEqual([prepared.agentId]);
      expect((await runOf(reopened, run.id)).executionStatus).toBe("running");
      await reopened.coordinator.recover();
      expect(reopened.launches).toHaveLength(1);
    },
  );

  it("never restarts an ambiguous starting window without matching host evidence", async () => {
    const h = await harness({}, false);
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    await changeCrashWindow(h, run, "starting");
    await close(h);
    const reopened = await harness();
    const recovered = await runOf(reopened, run.id);
    expect(recovered.executionStatus).toBe("unknown");
    expect(recovered.managed?.reservation).toBe(true);
    expect(reopened.launches).toHaveLength(0);
  });

  it.each(["starting", "running"] as const)(
    "adopts an existing host after a %s crash and reconciles its prompt evidence",
    async (status) => {
      const h = await harness({}, false);
      const prepared = makePrepared({ clientMessageId: "caller-message-identity" });
      const run = await h.coordinator.admitPrepared(prepared, occurrence());
      await changeCrashWindow(h, run, status);
      const stored = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
        defined(run.managed).artifact,
      );
      const evidence = hostEvidence(stored.prepared);
      evidence.agent.status = "idle";
      evidence.agent.attentionReason = "finished";
      evidence.agent.attentionTimestamp = new Date(START + 1_000).toISOString();
      evidence.timeline.entries.push({
        seqEnd: 2,
        item: { type: "assistant_message", text: "Observed completion, not verified success" },
      });
      evidence.timeline.endCursor = { epoch: "host-session", seq: 2 };
      const agents = new Map([[prepared.agentId, evidence]]);
      await close(h);
      const reopened = await harness({}, true, agents);
      const recovered = await runOf(reopened, run.id);
      expect(recovered.executionStatus).toBe("completed");
      expect(recovered.taskOutcome).toBe("unknown");
      expect(recovered.managed?.reservation).toBe(false);
      expect(recovered.output).toBe("Observed completion, not verified success");
      expect(recovered.managed?.timeline).toEqual({ epoch: "host-session", seq: 2 });
      expect(reopened.launches).toHaveLength(0);
    },
  );
});

describe("host recovery evidence boundaries", () => {
  it.each(["agent", "run", "execution", "prompt", "gap"])(
    "does not settle host evidence with mismatching %s identity",
    async (mismatch) => {
      const h = await harness();
      const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
      const evidence = defined(h.agents.get(defined(run.agentId)));
      evidence.agent.status = "idle";
      evidence.agent.attentionReason = "finished";
      evidence.agent.attentionTimestamp = new Date(START + 1_000).toISOString();
      if (mismatch === "agent") evidence.agent.id = "different-agent";
      if (mismatch === "run") evidence.agent.labels[RUN_LABEL] = "different-run";
      if (mismatch === "execution") evidence.agent.labels[EXECUTION_LABEL] = "different-execution";
      if (mismatch === "prompt")
        defined(evidence.timeline.entries[0]).item.clientMessageId = "different-prompt";
      if (mismatch === "gap") evidence.timeline.gap = true;
      await close(h);
      const reopened = await harness({}, true, h.agents);
      const recovered = await runOf(reopened, run.id);
      expect(recovered.executionStatus).toBe("unknown");
      expect(recovered.managed?.reservation).toBe(true);
      expect(reopened.launches).toHaveLength(0);
    },
  );
});

describe("cancellation safety", () => {
  it("cancels queued work without host effects but keeps active unsupported cancellation reserved", async () => {
    const h = await harness();
    const active = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    const queued = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ due: new Date(START + 1_000), overlap: "queue" }),
    );
    const canceled = await h.coordinator.cancel(queued.id);
    expect(canceled.error).toBeNull();
    expect([canceled.run.executionStatus, canceled.run.taskOutcome]).toEqual(["canceled", "no_change"]);
    expect(canceled.run.managed?.reservation).toBe(false);
    const unsupported = await h.coordinator.cancel(active.id);
    expect(unsupported.error).toContain("does not expose active cancellation");
    expect(unsupported.run.executionStatus).toBe("running");
    expect(unsupported.run.managed?.reservation).toBe(true);
    expect(unsupported.run.managed?.cancelRequested).toBe(true);
    await complete(h, active);
    expect(h.launches).toHaveLength(1);
    expect((await runOf(h, active.id)).taskOutcome).toBe("unknown");
  });

  it("requests host cancellation without asserting absence of external effects", async () => {
    const cancel = vi.fn(async (_agentId: string) => {});
    const h = await harness({ cancel });
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    const result = await h.coordinator.cancel(run.id);
    expect(cancel).toHaveBeenCalledWith(run.agentId);
    expect(result.run.executionStatus).toBe("running");
    expect(result.run.managed?.reservation).toBe(true);
    await h.coordinator.finished(defined(run.agentId), { kind: "canceled", executionId: run.executionId });
    const settled = await runOf(h, run.id);
    expect([settled.executionStatus, settled.taskOutcome]).toEqual(["canceled", "unknown"]);
    expect(settled.managed?.reservation).toBe(false);
  });
});

describe("artifact publication interruption", () => {
  it.each(["before", "after"] as const)(
    "never calls the host when interrupted %s the artifact write",
    async (boundary) => {
      const h = await harness();
      const publish = RunArtifacts.prototype.put;
      let artifactRef: RunArtifactRef | undefined;
      const publication = vi.spyOn(RunArtifacts.prototype, "put").mockImplementation(async function (
        this: RunArtifacts,
        value: unknown,
      ) {
        if (boundary === "after") artifactRef = await publish.call(this, value);
        throw new Error("Interrupted artifact publication");
      });
      try {
        await expect(h.coordinator.admitPrepared(makePrepared(), occurrence())).rejects.toThrow(
          "Interrupted artifact publication",
        );
        expect(h.launches).toHaveLength(0);
        const disk = await new RunStore(h.store.path).read();
        expect(disk.coordinator.occurrences).toEqual({});
        expect(disk.routines).toEqual({});
        if (boundary === "after") {
          const artifact = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
            defined(artifactRef),
          );
          expect(artifact.prepared.prompt).toBe("Review the inbox without changing external data.");
        }
      } finally {
        publication.mockRestore();
      }
      await close(h);
      const reopened = await harness();
      const run = await reopened.coordinator.admitPrepared(makePrepared(), occurrence());
      expect(run.executionStatus).toBe("running");
      expect(reopened.launches).toHaveLength(1);
    },
  );
});

describe("metadata commit interruption", () => {
  it.each([
    { stage: "queued", boundary: "before", durable: null, recovery: null },
    { stage: "queued", boundary: "after", durable: "queued", recovery: "running" },
    { stage: "reserved", boundary: "before", durable: "queued", recovery: "running" },
    { stage: "reserved", boundary: "after", durable: "reserved", recovery: "running" },
    { stage: "starting", boundary: "before", durable: "reserved", recovery: "running" },
    { stage: "starting", boundary: "after", durable: "starting", recovery: "unknown" },
    { stage: "running", boundary: "before", durable: "starting", recovery: "running" },
    { stage: "running", boundary: "after", durable: "running", recovery: "running" },
  ] as const)(
    "recovers $stage interrupted $boundary its durable commit",
    async ({ stage, boundary, durable, recovery }) => {
      const store = new InterruptedStore(join(directory, "routines.json"), { stage, boundary });
      const h = await harness({ store });
      const prepared = makePrepared();
      await expect(h.coordinator.admitPrepared(prepared, occurrence())).rejects.toThrow(
        "Injected process interruption",
      );
      const snapshot = await new RunStore(store.path).read();
      const saved = snapshot.routines["routine-1"]?.runs[0];
      expect(saved?.executionStatus ?? null).toBe(durable);
      expect(h.launches).toHaveLength(stage === "running" ? 1 : 0);
      if (saved) {
        const artifact = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
          defined(saved.managed).artifact,
        );
        expect(artifact.prepared.agentId).toBe(prepared.agentId);
        expect(defined(saved.managed).reservation).toBe(durable !== "queued");
      }
      await close(h);
      const reopened = await harness({}, true, h.agents);
      if (!saved) {
        expect((await reopened.coordinator.list()).runs).toEqual([]);
        await reopened.coordinator.admitPrepared(prepared, occurrence());
        expect(reopened.launches).toHaveLength(1);
        return;
      }
      const recovered = await runOf(reopened, saved.id);
      expect(recovered.executionStatus).toBe(recovery);
      expect(recovered.agentId).toBe(prepared.agentId);
      expect(recovered.managed?.reservation).toBe(true);
      const expectedLaunches = durable === "starting" || durable === "running" ? 0 : 1;
      expect(reopened.launches).toHaveLength(expectedLaunches);
      await reopened.coordinator.recover();
      expect(reopened.launches).toHaveLength(expectedLaunches);
    },
  );

  it("adopts a host that accepted creation before transport loss without reissuing the call", async () => {
    const agents = new Map<string, AgentEvidence>();
    const h = await harness(
      {
        launch: async (_host, _relay, prepared) => {
          agents.set(prepared.agentId, hostEvidence(prepared));
          throw new Error("Transport lost after host accepted creation");
        },
      },
      true,
      agents,
    );
    const run = await h.coordinator.admitPrepared(makePrepared(), occurrence());
    expect(run.executionStatus).toBe("unknown");
    expect(h.launches).toHaveLength(1);
    await close(h);
    const reopened = await harness({}, true, agents);
    expect((await runOf(reopened, run.id)).executionStatus).toBe("running");
    expect((await runOf(reopened, run.id)).managed?.reservation).toBe(true);
    expect(reopened.launches).toHaveLength(0);
  });
});

describe("opaque occurrence request identity", () => {
  it("keeps manual and webhook requests distinct even with the same request ID", async () => {
    const h = await harness();
    const manual = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ trigger: "manual", requestId: "opaque:@/# request", overlap: "queue" }),
    );
    const webhook = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ trigger: "webhook", requestId: "opaque:@/# request", overlap: "queue" }),
    );
    expect(webhook.id).not.toBe(manual.id);
    expect(webhook.occurrenceKey).not.toBe(manual.occurrenceKey);
    const replay = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ trigger: "manual", requestId: "opaque:@/# request" }),
    );
    expect(replay.id).toBe(manual.id);
  });

  it("does not concatenate opaque record and request IDs across delimiter boundaries", async () => {
    const h = await harness();
    const first = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ trigger: "manual", routineId: "routine#a", requestId: "b" }),
    );
    const second = await h.coordinator.admitPrepared(
      makePrepared(),
      occurrence({ trigger: "manual", routineId: "routine", requestId: "a#b" }),
    );
    expect(second.id).not.toBe(first.id);
    expect(second.occurrenceKey).not.toBe(first.occurrenceKey);
    expect(h.launches).toHaveLength(2);
  });
});
