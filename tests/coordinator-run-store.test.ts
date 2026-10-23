import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Relay } from "../server/relay";
import { RunCoordinator } from "../server/run-coordinator";
import { appendRun, emptyRecord, RunStore } from "../server/run-store";
import type { RoutineRun } from "../shared/rpc";
import { occurrenceKeyOf } from "../shared/runs";
import { defined, fakeHost, makeRun } from "./helpers";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-coordinator-run-store-"));
  path = join(directory, "routines.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function terminalReservation(executionStatus: "completed" | "failed" | "canceled"): RoutineRun {
  const run = makeRun(`reserved-${executionStatus}`, { executionStatus });
  run.managed = {
    botId: "bot-1",
    routineId: "rt",
    requestId: run.id,
    artifact: { id: "a".repeat(64), sha256: "a".repeat(64) },
    provider: "omp",
    model: "frozen-model",
    systemPromptHash: null,
    userPromptHash: null,
    environmentVersion: null,
    resourceIds: ["shared-resource"],
    overlap: "queue",
    overlapLimit: 1,
    reservation: true,
    notBefore: 0,
    attempts: [],
    timeline: null,
    creation: null,
    cancelRequested: false,
    coalescedInto: null,
  };
  return run;
}

describe("coordinator history version migration", () => {
  it("preserves exact v1 bytes on first v2 write and retains both backups through reopen", async () => {
    const historic = makeRun("historic");
    const original = `${JSON.stringify(
      {
        version: 1,
        routines: { rt: { lastRunAt: historic.scheduledFor, runs: [historic] } },
      },
      null,
      "\t",
    )}\n\n`;
    const preStoreBackup = '{"legacy":"original unversioned history"}\n';
    await writeFile(path, original);
    await writeFile(`${path}.pre-run-store`, preStoreBackup);
    const store = new RunStore(path);
    const before = await store.read();
    expect(defined(before.routines.rt).runs).toEqual([historic]);
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(stat(`${path}.v1.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    const added = makeRun("after-migration");
    await store.updateState(({ routines, coordinator }) => {
      appendRun(defined(routines.rt), added);
      coordinator.occurrences[added.occurrenceKey] = added.id;
      coordinator.circuits.omp = { failures: 2, openUntil: 12345, probe: false };
    });
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
    expect(await readFile(`${path}.pre-run-store`, "utf8")).toBe(preStoreBackup);
    const reopened = new RunStore(path);
    const migrated = await reopened.read();
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
    expect(defined(migrated.routines.rt).runs).toEqual([historic, added]);
    expect(migrated.coordinator).toEqual({
      occurrences: { [historic.occurrenceKey]: historic.id, [added.occurrenceKey]: added.id },
      circuits: { omp: { failures: 2, openUntil: 12345, probe: false } },
    });
    await reopened.updateState(({ coordinator }) => {
      coordinator.circuits.omp = { failures: 0, openUntil: 0, probe: false };
    });
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(original);
    expect(await readFile(`${path}.pre-run-store`, "utf8")).toBe(preStoreBackup);
    expect((await new RunStore(path).read()).coordinator.circuits.omp).toEqual({
      failures: 0,
      openUntil: 0,
      probe: false,
    });
  });
});

describe("unreadable managed execution safety", () => {
  it.each([
    '{"version":2,"routines":{"rt":{"runs":[',
    JSON.stringify({ version: 2, routines: {}, coordinator: { occurrences: "lost", circuits: {} } }),
  ])("refuses reads and writes without freeing unknown history: %s", async (original) => {
    await writeFile(path, original);
    const store = new RunStore(path);
    await expect(store.read()).rejects.toThrow("file left unchanged");
    await expect(
      store.updateState(({ routines }) => {
        routines.new = emptyRecord();
      }),
    ).rejects.toThrow("file left unchanged");
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(new RunStore(path).read()).rejects.toThrow("file left unchanged");
  });
});

describe("coordinator history retention", () => {
  it("keeps every uncertain execution and reservation in addition to the latest 30 terminal runs", async () => {
    const protectedRuns = [
      ...(
        ["queued", "reserved", "starting", "running", "waiting_for_user", "verifying", "unknown"] as const
      ).map((executionStatus) => makeRun(`protected-${executionStatus}`, { executionStatus, endedAt: null })),
      ...(["completed", "failed", "canceled"] as const).map(terminalReservation),
    ];
    const terminalRuns = Array.from({ length: 45 }, (_, index) =>
      makeRun(`terminal-${index}`, {
        executionStatus: (["completed", "failed", "canceled"] as const)[index % 3],
      }),
    );
    const store = new RunStore(path);
    await store.updateState(({ routines, coordinator }) => {
      const record = emptyRecord();
      routines.rt = record;
      for (const run of [...terminalRuns.slice(0, 10), ...protectedRuns, ...terminalRuns.slice(10)]) {
        appendRun(record, run);
        coordinator.occurrences[run.occurrenceKey] = run.id;
      }
    });
    const reopened = await new RunStore(path).read();
    expect(defined(reopened.routines.rt).runs).toEqual([...protectedRuns, ...terminalRuns.slice(15)]);
  });
});

describe("retained occurrence identity", () => {
  it("refuses a scheduled occurrence after its terminal run was pruned and the process reopened", async () => {
    const due = new Date("2026-10-01T09:00:00.000Z");
    const historic = makeRun("original-occurrence", {
      trigger: "schedule",
      scheduledFor: due.toISOString(),
      occurrenceKey: occurrenceKeyOf("rt", "schedule", due.toISOString(), "original-occurrence"),
    });
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        routines: { rt: { lastRunAt: due.toISOString(), runs: [historic] } },
      }),
    );
    await new RunStore(path).updateState(({ routines, coordinator }) => {
      for (let index = 0; index < 31; index++) {
        const run = makeRun(`later-${index}`);
        appendRun(defined(routines.rt), run);
        coordinator.occurrences[run.occurrenceKey] = run.id;
      }
    });
    const reopened = new RunStore(path);
    const before = await reopened.read();
    expect(defined(before.routines.rt).runs.map((run) => run.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `later-${index + 1}`),
    );
    expect(before.coordinator.occurrences[historic.occurrenceKey]).toBe(historic.id);
    const savedBytes = await readFile(path, "utf8");
    const host = fakeHost([]);
    const coordinator = new RunCoordinator(host, new Relay(host, []), { store: reopened });
    try {
      await expect(coordinator.recordMissed("rt", due, new Date("2026-10-02T09:00:00.000Z"))).rejects.toThrow(
        "replay refused",
      );
      expect(await readFile(path, "utf8")).toBe(savedBytes);
      const after = await new RunStore(path).read();
      expect(after.routines).toEqual(before.routines);
      expect(after.coordinator.occurrences).toEqual(before.coordinator.occurrences);
    } finally {
      await coordinator.stop();
    }
  });
});
