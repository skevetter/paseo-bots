import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { RunArtifacts } from "../server/run-artifacts";
import {
  type CoordinatorOptions,
  type ManagedSessionOpening,
  type ManagedSessionReceipt,
  RunCoordinator,
} from "../server/run-coordinator";
import { emptyRecord, RunStore } from "../server/run-store";
import type { PreparedBotChat } from "../shared/chat";
import { SessionEpochSchema } from "../shared/runs";
import { makePrepared } from "./coordinator-fixture";
import { defined, fakeHost, makeBot, makeRun } from "./helpers";

const NOW = Date.parse("2026-10-23T10:00:00.000Z");
let directory: string;
let coordinators: RunCoordinator[];

interface SessionHarness {
  coordinator: RunCoordinator;
  store: RunStore;
  launches: PreparedBotChat[];
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-session-open-"));
  coordinators = [];
});

afterEach(async () => {
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.stop()));
  await rm(directory, { recursive: true, force: true });
});

async function harness(options: CoordinatorOptions = {}, attached = true): Promise<SessionHarness> {
  const host = fakeHost([makeBot({ executionMode: "managed", provider: "omp", model: "frozen-model" })]);
  const store = new RunStore(join(directory, "routines.json"));
  const launches: PreparedBotChat[] = [];
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => NOW,
    jitter: () => 0,
    reconcileIntervalMs: 60_000,
    refresh: async (_relay, prepared) => prepared,
    ...options,
    store,
    launch: async (launchHost, relay, prepared, observer) => {
      launches.push(structuredClone(prepared));
      return options.launch ? options.launch(launchHost, relay, prepared, observer) : prepared.agentId;
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
  return { coordinator, store, launches };
}

async function close(h: SessionHarness) {
  await h.coordinator.stop();
  coordinators.splice(coordinators.indexOf(h.coordinator), 1);
}

function prepared(): PreparedBotChat {
  return makePrepared({ placement: { path: join(directory, "workspace"), projectRoot: null } });
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

async function admit(h: SessionHarness, plan: PreparedBotChat, deferLaunch = false) {
  return h.coordinator.admitPrepared(plan, {
    trigger: "manual",
    due: new Date(NOW),
    requestId: "session-request",
    deferLaunch,
  });
}

describe("managed initial provider-session opening", () => {
  it("persists the started execution before the create hook and binds numeric generation one", async () => {
    let receipt: ManagedSessionReceipt | null = null;
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        const disk = await new RunStore(join(directory, "routines.json")).read();
        const run = defined(disk.routines["chat:bot-1"]?.runs[0]);
        expect(run.executionStatus).toBe("starting");
        expect(run.sessionEpoch).toBe(1);
        expect(run.managed?.launchIntent).toBe(true);
        expect(run.managed?.reservation).toBe(true);
        const artifact = await new RunArtifacts(directory).get<{ prepared: PreparedBotChat }>(
          defined(run.managed).artifact,
        );
        expect(artifact.prepared.agentId).toBe(plan.agentId);
        const [first, retried] = await Promise.all([
          h.coordinator.sessionOpened(opening(plan)),
          h.coordinator.sessionOpened(opening(plan)),
        ]);
        receipt = first;
        expect(retried).toEqual(first);
        const sessions = (await new RunStore(h.store.path).read()).coordinator.sessions[plan.agentId];
        expect(sessions).toEqual([
          expect.objectContaining({
            sessionEpoch: 1,
            requestId: defined(receipt).requestId,
            executionId: run.executionId,
            workspaceId: "workspace-1",
            state: "pending",
            activeAt: null,
          }),
        ]);
        return plan.agentId;
      },
    });
    const run = await admit(h, prepared());
    expect(receipt).toMatchObject({ sessionEpoch: 1 });
    expect(run.executionStatus).toBe("running");
    expect(run.sessionEpoch).toBe(1);
    expect((await h.store.read()).coordinator.sessions[defined(run.agentId)]?.[0]?.state).toBe("pending");
  });

  it("reuses a pending generation and bind request across hook retry and coordinator restart", async () => {
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        await h.coordinator.sessionOpened(opening(plan));
        return plan.agentId;
      },
    });
    const plan = prepared();
    const run = await admit(h, plan);
    const first = defined(await h.coordinator.sessionOpened(opening(plan)));
    expect(first.sessionEpoch).toBe(1);
    await close(h);
    const reopened = await harness({}, false);
    const retried = await reopened.coordinator.sessionOpened(opening(plan, { reason: "resume" }));
    expect(retried).toEqual(first);
    expect((await reopened.store.read()).coordinator.sessions[plan.agentId]).toEqual([
      expect.objectContaining({ sessionEpoch: 1, requestId: first.requestId, state: "pending" }),
    ]);
    expect((await reopened.coordinator.get(run.id))?.sessionEpoch).toBe(1);
    expect(reopened.launches).toHaveLength(0);
  });
});

describe("actual session activation evidence", () => {
  it("can prove host creation before the create call returns its acknowledgement", async () => {
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        await h.coordinator.sessionOpened(opening(plan));
        await h.coordinator.sessionActive(plan.agentId);
        const disk = await new RunStore(h.store.path).read();
        const run = defined(disk.routines["chat:bot-1"]?.runs[0]);
        expect(run.managed?.hostCreatedAt).toBe(NOW);
        expect(run.executionStatus).toBe("running");
        expect(disk.coordinator.sessions[plan.agentId]?.[0]).toMatchObject({
          state: "active",
          activeAt: NOW,
          sessionEpoch: 1,
        });
        const receipt = await h.coordinator.waitForCreation(run.id, { timeoutMs: 0 });
        expect(receipt.status).toBe("created");
        return plan.agentId;
      },
    });
    const run = await admit(h, prepared());
    expect(run.managed?.hostCreatedAt).toBe(NOW);
    expect(run.sessionEpoch).toBe(1);
  });
});

describe("observed provider-session generations", () => {
  it("advances only after activation and preserves pending resume identity through another restart", async () => {
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        await h.coordinator.sessionOpened(opening(plan));
        return plan.agentId;
      },
    });
    const plan = prepared();
    const run = await admit(h, plan);
    const first = defined(await h.coordinator.sessionOpened(opening(plan)));
    await h.coordinator.sessionActive(plan.agentId);
    const second = defined(await h.coordinator.sessionOpened(opening(plan, { reason: "resume" })));
    expect(second.sessionEpoch).toBe(2);
    expect(second.requestId).not.toBe(first.requestId);
    await close(h);
    const reopened = await harness({}, false);
    expect(await reopened.coordinator.sessionOpened(opening(plan, { reason: "refresh" }))).toEqual(second);
    await reopened.coordinator.sessionActive(plan.agentId);
    const third = defined(await reopened.coordinator.sessionOpened(opening(plan, { reason: "refresh" })));
    expect(third.sessionEpoch).toBe(3);
    expect(third.requestId).not.toBe(second.requestId);
    const sessions = (await new RunStore(reopened.store.path).read()).coordinator.sessions[plan.agentId];
    expect(sessions?.map((session) => [session.sessionEpoch, session.state])).toEqual([
      [1, "active"],
      [2, "active"],
      [3, "pending"],
    ]);
    expect((await reopened.coordinator.get(run.id))?.sessionEpoch).toBe(3);
    expect(reopened.launches).toHaveLength(0);
  });

  it("preserves legacy generation zero instead of fabricating a managed session", async () => {
    const h = await harness({}, false);
    const plan = prepared();
    const legacy = makeRun("legacy-session", {
      agentId: plan.agentId,
      sessionEpoch: SessionEpochSchema.parse(0),
    });
    await h.store.updateState((state) => {
      state.routines.legacy = { ...emptyRecord(), runs: [legacy] };
    });
    expect(await h.coordinator.sessionOpened(opening(plan, { reason: "import" }))).toBeNull();
    const disk = await new RunStore(h.store.path).read();
    expect(disk.routines.legacy?.runs[0]?.sessionEpoch).toBe(0);
    expect(disk.coordinator.sessions[plan.agentId]).toBeUndefined();
  });
});

describe("non-executing history opening", () => {
  it("does not change a single persisted byte or advance an active session", async () => {
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        await h.coordinator.sessionOpened(opening(plan));
        return plan.agentId;
      },
    });
    const plan = prepared();
    await admit(h, plan);
    await h.coordinator.sessionActive(plan.agentId);
    await close(h);
    const reopened = await harness({}, false);
    const before = await readFile(reopened.store.path);
    const result = await reopened.coordinator.sessionOpened(
      opening(plan, {
        purpose: "history",
        reason: "refresh",
        provider: "different-provider",
        cwd: "/history-only",
      }),
    );
    expect(result).toBeNull();
    expect(await readFile(reopened.store.path)).toEqual(before);
  });

  it("does not create run history when browsing an unrelated unmanaged agent", async () => {
    const h = await harness({}, false);
    expect(await h.coordinator.sessionOpened(opening(prepared(), { purpose: "history" }))).toBeNull();
    await expect(readFile(h.store.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(h.launches).toHaveLength(0);
  });
});

describe("provider-session identity gate", () => {
  it.each([
    { field: "provider", patch: { provider: "different-provider" } },
    { field: "working directory", patch: { cwd: "/different-workspace" } },
  ])("blocks a mismatching $field in the create hook before provider start", async ({ patch }) => {
    let gate: Promise<ManagedSessionReceipt | null> | undefined;
    let providerStarted = false;
    const h = await harness({
      launch: async (_host, _relay, plan) => {
        gate = h.coordinator.sessionOpened(opening(plan, patch));
        await gate;
        providerStarted = true;
        return plan.agentId;
      },
    });
    const run = await admit(h, prepared());
    await expect(defined(gate)).rejects.toThrow(/identity|provider|directory/i);
    expect(providerStarted).toBe(false);
    expect(run.managed?.hostCreatedAt).toBeUndefined();
    expect((await h.store.read()).coordinator.sessions).toEqual({});
  });
});

describe("provider-session placement and artifact identity", () => {
  it.each([null, "workspace-1"])(
    "blocks a changed workspace after initial placement %s",
    async (workspaceId) => {
      const h = await harness({
        launch: async (_host, _relay, plan) => {
          await h.coordinator.sessionOpened(opening(plan, { workspaceId }));
          return plan.agentId;
        },
      });
      const plan = prepared();
      await admit(h, plan);
      await h.coordinator.sessionActive(plan.agentId);
      const before = await readFile(h.store.path);
      await expect(
        h.coordinator.sessionOpened(
          opening(plan, {
            reason: "resume",
            workspaceId: "workspace-2",
          }),
        ),
      ).rejects.toThrow(/placement|workspace/i);
      expect(await readFile(h.store.path)).toEqual(before);
    },
  );

  it.each(["not-a-uuid", "another-uuid"])(
    "blocks a matched run whose %s agent identity differs from its immutable artifact",
    async (kind) => {
      const h = await harness();
      const plan = prepared();
      const run = await admit(h, plan);
      const changedAgentId = kind === "another-uuid" ? randomUUID() : kind;
      await h.store.updateState((state) => {
        const saved = defined(state.routines["chat:bot-1"]?.runs.find((entry) => entry.id === run.id));
        saved.agentId = changedAgentId;
      });
      await expect(
        h.coordinator.sessionOpened(
          opening(plan, {
            agentId: changedAgentId,
            reason: "resume",
          }),
        ),
      ).rejects.toThrow(/identity|agent|UUID/i);
      expect((await h.store.read()).coordinator.sessions[changedAgentId]).toBeUndefined();
    },
  );
});

describe("unstarted and unrelated session openings", () => {
  it.each([false, true])(
    "blocks queued execution before host intent with deferLaunch=%s",
    async (deferLaunch) => {
      const h = await harness({}, false);
      const plan = prepared();
      const run = await admit(h, plan, deferLaunch);
      expect(run.executionStatus).toBe("queued");
      await expect(h.coordinator.sessionOpened(opening(plan))).rejects.toThrow(/intent|start/i);
      expect((await h.store.read()).coordinator.sessions[plan.agentId]).toBeUndefined();
      expect(h.launches).toHaveLength(0);
    },
  );

  it("cannot reopen a canceled pre-creation execution", async () => {
    const h = await harness({}, false);
    const plan = prepared();
    const run = await admit(h, plan);
    await h.coordinator.cancel(run.id);
    await expect(h.coordinator.sessionOpened(opening(plan, { reason: "resume" }))).rejects.toThrow(
      /intent|start|cancel/i,
    );
    expect((await h.store.read()).coordinator.sessions[plan.agentId]).toBeUndefined();
    expect(h.launches).toHaveLength(0);
  });

  it("returns null for an unrelated unmanaged agent without assigning it a generation", async () => {
    const h = await harness({}, false);
    const plan = prepared();
    expect(await h.coordinator.sessionOpened(opening(plan, { reason: "import" }))).toBeNull();
    expect((await h.store.read()).coordinator.sessions[plan.agentId]).toBeUndefined();
  });
});
