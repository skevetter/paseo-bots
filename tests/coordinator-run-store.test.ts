import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendRun, displayRecords, emptyRecord, RunStore } from "../server/run-store";
import { CoordinatorStateSchema } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { occurrenceKeyOf } from "../shared/runs";
import { defined, makeRun } from "./helpers";

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
  it.each([1, 2])(
    "backs up exact v%i bytes before v4 and preserves older backups through reopen",
    async (version) => {
      const historic = makeRun("historic");
      const original = `${JSON.stringify(
        {
          version,
          routines: { rt: { lastRunAt: historic.scheduledFor, runs: [historic] } },
          ...(version === 2 ? { coordinator: { occurrences: {}, circuits: {} } } : {}),
        },
        null,
        "\t",
      )}\n\n`;
      const preStoreRun = makeRun("pre-store", { output: "pre-store output" });
      const preStoreBackup = `${JSON.stringify({ "rt-pre-store": { lastRunAt: preStoreRun.scheduledFor, runs: [null, preStoreRun] } }, null, 2)}\n`;
      await writeFile(path, original);
      await writeFile(`${path}.pre-run-store`, preStoreBackup);
      const store = new RunStore(path);
      const before = await store.read();
      expect(defined(before.routines.rt).runs).toEqual([historic]);
      expect(await readFile(path, "utf8")).toBe(original);
      await expect(stat(`${path}.v${version}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      const added = makeRun("after-migration");
      await store.updateState(({ routines, coordinator }) => {
        appendRun(defined(routines.rt), added);
        coordinator.occurrences[added.occurrenceKey] = added.id;
        coordinator.circuits.omp = { failures: 2, openUntil: 12345, probe: false };
      });
      expect(await readFile(`${path}.v${version}.bak`, "utf8")).toBe(original);
      expect(await readFile(`${path}.pre-run-store`, "utf8")).toBe(preStoreBackup);
      const reopened = new RunStore(path);
      const migrated = await reopened.read();
      expect(JSON.parse(await readFile(path, "utf8")).version).toBe(4);
      expect(defined(migrated.routines.rt).runs).toEqual([historic, added]);
      expect(migrated.coordinator).toEqual(
        CoordinatorStateSchema.parse({
          occurrences: { [historic.occurrenceKey]: historic.id, [added.occurrenceKey]: added.id },
          circuits: { omp: { failures: 2, openUntil: 12345, probe: false } },
        }),
      );
      await reopened.updateState(({ coordinator }) => {
        coordinator.circuits.omp = { failures: 0, openUntil: 0, probe: false };
      });
      expect(await readFile(`${path}.v${version}.bak`, "utf8")).toBe(original);
      expect(await readFile(`${path}.pre-run-store`, "utf8")).toBe(preStoreBackup);
      expect((await new RunStore(path).read()).coordinator.circuits.omp).toEqual({
        failures: 0,
        openUntil: 0,
        probe: false,
      });
    },
  );
});

describe("legacy empty slots", () => {
  it("bootstraps claims over null holes, keeps valid runs byte-for-byte, and writes no fabricated fields", async () => {
    const legacy = {
      id: "legacy-kept",
      trigger: "manual",
      scheduledFor: "2026-09-19T09:00:00.000Z",
      startedAt: "2026-09-19T09:00:00.000Z",
      endedAt: "2026-09-19T09:01:00.000Z",
      status: "completed",
      agentId: null,
      output: "legacy output",
      error: null,
    };
    const original = JSON.stringify({
      "rt-null": null,
      "rt-holes": { lastRunAt: null, runs: [null, legacy] },
    });
    await writeFile(path, original);
    const store = new RunStore(path);
    await store.backfillManagedAgentClaims();
    expect(await readFile(path, "utf8")).toBe(original);
    const { routines } = await store.read();
    expect(routines["rt-null"]).toEqual(emptyRecord());
    const runs = defined(routines["rt-holes"]).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: "legacy-kept",
      output: "legacy output",
      sessionEpoch: 0,
      verification: null,
    });
    await store.updateState(() => {});
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.version).toBe(4);
    expect(saved.routines["rt-holes"].runs.map((run: { id: string }) => run.id)).toEqual(["legacy-kept"]);
  });
});

describe("unreadable managed execution safety", () => {
  it.each([
    '{"version":2,"routines":{"rt":{"runs":[',
    JSON.stringify({ version: 2, routines: {}, coordinator: { occurrences: "lost", circuits: {} } }),
    JSON.stringify({
      version: 2,
      routines: { rt: { lastRunAt: null, runs: [null] } },
      coordinator: { occurrences: {}, circuits: {} },
    }),
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
  it("retains all detailed evidence while projecting only 30 unprotected terminal display rows", async () => {
    const protectedRuns = [
      ...(
        ["queued", "reserved", "starting", "running", "waiting_for_user", "verifying", "unknown"] as const
      ).map((executionStatus) => makeRun(`protected-${executionStatus}`, { executionStatus, endedAt: null })),
      ...(["completed", "failed", "canceled"] as const).map(terminalReservation),
    ];
    const pinned = makeRun("candidate-evidence", {
      managed: {
        ...defined(terminalReservation("completed").managed),
        requestId: "candidate-evidence",
        reservation: false,
        evidencePins: ["candidate-1"],
      },
    });
    protectedRuns.push(pinned);
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
    expect(defined(reopened.routines.rt).runs).toEqual([
      ...terminalRuns.slice(0, 10),
      ...protectedRuns,
      ...terminalRuns.slice(10),
    ]);
    const display = displayRecords(reopened.routines);
    expect(defined(display.rt).runs).toEqual([...protectedRuns, ...terminalRuns.slice(15)]);
    defined(display.rt).runs[0] = makeRun("consumer-edit");
    expect(defined(reopened.routines.rt).runs[10]).toEqual(protectedRuns[0]);
  });
});

describe("retained occurrence identity", () => {
  it("keeps an old scheduled occurrence retrievable after its display row is hidden and index rebuilt", async () => {
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
    expect(defined(displayRecords(before.routines).rt).runs.map((run) => run.id)).toEqual(
      Array.from({ length: 30 }, (_, index) => `later-${index + 1}`),
    );
    expect(before.coordinator.occurrences[historic.occurrenceKey]).toBe(historic.id);
    const savedBytes = await readFile(path, "utf8");
    await reopened.rebuildIndex();
    expect(await reopened.get(historic.id)).toEqual(historic);
    expect((await reopened.list({ routineId: "rt", limit: 100 })).runs.map((run) => run.id).sort()).toEqual(
      [historic.id, ...Array.from({ length: 31 }, (_, index) => `later-${index}`)].sort(),
    );
    expect(await readFile(path, "utf8")).toBe(savedBytes);
  });
});
