import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaseoApi } from "../server/paseo";
import { Relay } from "../server/relay";
import { RunArtifacts } from "../server/run-artifacts";
import { type CoordinatorOptions, RunCoordinator } from "../server/run-coordinator";
import { RunStore } from "../server/run-store";
import { BOT_LABEL, type Routine } from "../shared/bot";
import type { PreparedBotChat } from "../shared/chat";
import { newSchedulePolicy } from "../shared/schedule-policy";
import { planOccurrences, scheduleNotBefore } from "../shared/schedule-recovery";
import { makePrepared } from "./coordinator-fixture";
import { defined, fakeHost, makeBot } from "./helpers";

const NOW = Date.parse("2026-10-24T05:00:00.000Z");
let directory: string;
let clock: number;
let coordinators: RunCoordinator[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-scheduled-admission-"));
  clock = NOW;
  coordinators = [];
});
afterEach(async () => {
  await Promise.allSettled(coordinators.map((coordinator) => coordinator.stop()));
  await rm(directory, { recursive: true, force: true });
});

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: "rt-recovery",
    name: "Recovery",
    prompt: "Review the admitted inputs without changing external data.",
    enabled: true,
    resultsChatId: null,
    createdAt: "2026-10-24T01:00:00.000Z",
    schedule: { kind: "interval", minutes: 60 },
    schedulePolicy: {
      ...newSchedulePolicy("UTC"),
      catchUp: { windowSeconds: 86400, maxOccurrences: 4, strategy: "queue" },
    },
    runtime: { overlap: "queue" },
    ...patch,
  };
}

async function harness(selected: Routine, options: CoordinatorOptions = {}) {
  const bot = makeBot({
    executionMode: "managed",
    provider: "omp",
    model: "frozen-model",
    routines: [selected],
  });
  const host = fakeHost([bot]);
  const state = await host.values();
  const store = new RunStore(join(directory, "routines.json"));
  const launches: PreparedBotChat[] = [];
  const coordinator = new RunCoordinator(host, new Relay(host, []), {
    now: () => clock,
    jitter: () => 0,
    reconcileIntervalMs: 60_000,
    refresh: async (_relay, prepared) => prepared,
    prepare: async (_host, _relay, target, input) =>
      makePrepared({
        botId: target.id,
        agentId: defined(input.agentId),
        idempotencyKey: defined(input.idempotencyKey),
        prompt: input.prompt,
        labels: { [BOT_LABEL]: target.id, ...input.labels },
      }),
    ...options,
    store,
    launch: async (launchHost, relay, prepared, observer) => {
      launches.push(prepared);
      return options.launch ? options.launch(launchHost, relay, prepared, observer) : prepared.agentId;
    },
  });
  coordinators.push(coordinator);
  const recovery = vi.spyOn(coordinator, "recover");
  host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as unknown as PaseoApi);
  await defined(recovery.mock.results[0]).value;
  recovery.mockRestore();
  return { coordinator, store, launches, target: { state, bot, routine: selected } };
}

async function close(coordinator: RunCoordinator) {
  await coordinator.stop();
  coordinators.splice(coordinators.indexOf(coordinator), 1);
}

describe("scheduled recovery admission", () => {
  it("records unsafe scheduled deadlines without repeatedly stranding the intended cursor", async () => {
    const selected = routine({
      runtime: { overlap: "queue", deadlineSeconds: Number.MAX_SAFE_INTEGER },
      schedulePolicy: {
        ...newSchedulePolicy("UTC"),
        catchUp: { windowSeconds: 7200, maxOccurrences: 1, strategy: "latest" },
      },
    });
    const prepare = vi.fn();
    const h = await harness(selected, { prepare });
    const admitted = await h.coordinator.admitSchedule(
      h.target,
      planOccurrences(selected, null, new Date(clock)),
    );
    const candidate = defined(admitted.find((run) => run.skipped === null));
    expect([
      candidate.executionStatus,
      candidate.taskOutcome,
      candidate.agentCreationStatus,
      candidate.agentId,
    ]).toEqual(["failed", "unknown", "not_created", null]);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.launches).toEqual([]);
    const saved = defined((await h.store.read()).routines[selected.id]);
    expect(saved.lastRunAt).toBe(new Date(NOW).toISOString());
    expect(
      saved.runs
        .filter((run) => run.recovery)
        .map((run) => run.recovery?.reason)
        .sort(),
    ).toEqual(["outside_window", "recovery_limit"]);
    expect(planOccurrences(selected, saved.lastRunAt, new Date(clock)).runs).toEqual([]);
  });

  it("retains an ordinary admission rejection when deadline arithmetic is unsafe", async () => {
    const selected = routine({ schedulePolicy: undefined });
    const prepare = vi.fn();
    const h = await harness(selected, { prepare });
    const rejected = await h.coordinator.admit({
      ...h.target,
      trigger: "schedule",
      due: new Date(NOW),
      requestId: "schedule",
      prompt: selected.prompt,
      title: selected.name,
      deadlineAt: NOW + Number.MAX_SAFE_INTEGER * 1000,
    });
    expect([
      rejected.executionStatus,
      rejected.taskOutcome,
      rejected.agentCreationStatus,
      rejected.agentId,
    ]).toEqual(["failed", "unknown", "not_created", null]);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.launches).toEqual([]);
    const saved = defined((await h.store.read()).routines[selected.id]);
    expect(saved.lastRunAt).toBe(new Date(NOW).toISOString());
    expect(saved.runs.map((run) => run.id)).toContain(rejected.id);
  });
});

describe("atomic scheduled recovery publication", () => {
  it("publishes every selected frozen intent before the first host create", async () => {
    const selected = routine();
    let observed: string[] | undefined;
    const h = await harness(selected, {
      launch: async (_host, _relay, prepared) => {
        const disk = await new RunStore(join(directory, "routines.json")).read();
        observed = defined(disk.routines[selected.id])
          .runs.map((run) => run.scheduledFor)
          .sort();
        for (const run of defined(disk.routines[selected.id]).runs)
          await new RunArtifacts(directory).get(defined(run.managed).artifact);
        return prepared.agentId;
      },
    });
    const plan = planOccurrences(selected, null, new Date(clock));
    const admitted = await h.coordinator.admitSchedule(h.target, plan);
    await h.coordinator.waitForCreation(defined(admitted[0]).id, { timeoutMs: 5000 });
    expect(observed).toEqual(plan.runs.map((due) => due.toISOString()));
    const disk = await h.store.read();
    expect(disk.routines[selected.id]?.lastRunAt).toBe("2026-10-24T05:00:00.000Z");
    expect(new Set(admitted.map((run) => run.executionId)).size).toBe(4);
  });

  it.each(["artifact", "metadata"] as const)(
    "leaves the cursor and host untouched when %s publication fails after preparation",
    async (boundary) => {
      const selected = routine();
      const h = await harness(selected);
      const write =
        boundary === "artifact" ? vi.spyOn(RunArtifacts.prototype, "put") : vi.spyOn(h.store, "updateState");
      write.mockRejectedValueOnce(new Error("injected publication failure"));
      const plan = planOccurrences(selected, null, new Date(clock));
      await expect(h.coordinator.admitSchedule(h.target, plan)).rejects.toThrow(
        "injected publication failure",
      );
      write.mockRestore();
      expect((await h.store.read()).routines[selected.id]).toBeUndefined();
      expect(h.launches).toEqual([]);
      const admitted = await h.coordinator.admitSchedule(h.target, plan);
      expect(admitted.map((run) => run.scheduledFor)).toEqual(plan.runs.map((due) => due.toISOString()));
    },
  );
});

describe("scheduled intended times and suppression", () => {
  it("retains the intended occurrence and jitter gate across cold reopening", async () => {
    const selected = routine({
      createdAt: "2026-10-24T04:00:00.000Z",
      schedulePolicy: { ...newSchedulePolicy("UTC"), jitterToleranceSeconds: 120 },
    });
    const plan = planOccurrences(selected, null, new Date(clock));
    const intended = defined(plan.runs[0]);
    const notBefore = scheduleNotBefore(selected, intended);
    expect(notBefore).toBeGreaterThan(NOW);
    const first = await harness(selected);
    const run = defined((await first.coordinator.admitSchedule(first.target, plan))[0]);
    expect(run.managed?.notBefore).toBe(notBefore);
    expect(first.launches).toEqual([]);
    await close(first.coordinator);
    const reopened = await harness(selected);
    await reopened.coordinator.pump();
    expect(reopened.launches).toEqual([]);
    clock = notBefore;
    await reopened.coordinator.pump();
    const created = await reopened.coordinator.waitForCreation(run.id, { timeoutMs: 5000 });
    expect(created.status).toBe("created");
    expect(created.run.scheduledFor).toBe(intended.toISOString());
    expect((await reopened.store.read()).routines[selected.id]?.lastRunAt).toBe(intended.toISOString());
    expect(reopened.launches.map((prepared) => prepared.agentId)).toEqual([run.agentId]);
  });

  it("never rewinds the intended cursor when an older scheduled receipt lands later", async () => {
    const h = await harness(routine());
    await h.coordinator.recordMissed("rt-recovery", new Date(NOW), new Date(NOW));
    await h.coordinator.recordMissed("rt-recovery", new Date(NOW - 3600000), new Date(NOW));
    expect((await h.store.read()).routines["rt-recovery"]?.lastRunAt).toBe(new Date(NOW).toISOString());
  });

  it("records bounded unknown-outcome receipts for suppressed work while creating only the latest candidate", async () => {
    const selected = routine({
      schedulePolicy: {
        ...newSchedulePolicy("UTC"),
        catchUp: { windowSeconds: 7200, maxOccurrences: 1, strategy: "latest" },
      },
    });
    const h = await harness(selected);
    const admitted = await h.coordinator.admitSchedule(
      h.target,
      planOccurrences(selected, null, new Date(clock)),
    );
    const candidate = defined(admitted.find((run) => run.scheduledFor === new Date(NOW).toISOString()));
    await h.coordinator.waitForCreation(candidate.id, { timeoutMs: 5000 });
    const retained = defined((await h.store.read()).routines[selected.id]);
    expect(
      retained.runs
        .filter((run) => run.skipped === "missed")
        .map((run) => [run.scheduledFor, run.executionStatus, run.taskOutcome, run.agentCreationStatus])
        .sort(),
    ).toEqual([
      ["2026-10-24T02:00:00.000Z", "canceled", "unknown", "not_created"],
      ["2026-10-24T04:00:00.000Z", "canceled", "unknown", "not_created"],
    ]);
    expect(retained.lastRunAt).toBe("2026-10-24T05:00:00.000Z");
    expect(
      retained.runs
        .filter((run) => run.skipped === "missed")
        .sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor))
        .map((run) => [run.error, run.recovery]),
    ).toEqual([
      [
        null,
        {
          reason: "outside_window",
          count: 1,
          firstDue: "2026-10-24T02:00:00.000Z",
          plannedThrough: "2026-10-24T05:00:00.000Z",
          into: null,
        },
      ],
      [
        null,
        {
          reason: "recovery_limit",
          count: 2,
          firstDue: "2026-10-24T03:00:00.000Z",
          plannedThrough: "2026-10-24T05:00:00.000Z",
          into: null,
        },
      ],
    ]);
    expect(h.launches.map((prepared) => prepared.agentId)).toEqual([candidate.agentId]);
  });
});
