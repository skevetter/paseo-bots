import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyRecord, RunStore } from "../server/run-store";
import { ManagedRunSchema } from "../shared/managed-runs";
import { newSessionEpoch } from "../shared/runs";
import { defined, makeRun } from "./helpers";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-run-history-migration-"));
  path = join(directory, "routines.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function oldQueuedRun(id: string, startedAt: string, admissionOrder?: number) {
  const managed = ManagedRunSchema.parse({
    botId: "bot-a",
    routineId: "routine-a",
    requestId: id,
    artifact: { id: "a".repeat(64), sha256: "a".repeat(64) },
    provider: "omp",
    model: "frozen-model",
    systemPromptHash: null,
    userPromptHash: null,
    environmentVersion: null,
    resourceIds: [],
    overlap: "queue",
    reservation: false,
    notBefore: 0,
    attempts: [],
    timeline: null,
    creation: null,
    cancelRequested: false,
    coalescedInto: null,
    admissionOrder,
  });
  return makeRun(id, { startedAt, executionStatus: "queued", endedAt: null, managed });
}

describe("historical provider-session provenance", () => {
  it.each([1, 2])(
    "normalizes old v%i process markers to zero but preserves actual numeric generations",
    async (version) => {
      const fixture = JSON.parse(
        await readFile(
          new URL("./fixtures/routines-v1-process-epoch.json", import.meta.url).pathname,
          "utf8",
        ),
      );
      fixture.version = version;
      if (version === 2) fixture.coordinator = { occurrences: {}, circuits: {} };
      const numeric = makeRun("numeric-generation", { sessionEpoch: newSessionEpoch(6) });
      fixture.routines["rt-epoch"].runs.push(numeric);
      const original = `${JSON.stringify(fixture, null, 2)}\n`;
      await writeFile(path, original);
      const store = new RunStore(path);
      const before = await store.read();
      expect(defined(before.routines["rt-epoch"]).runs.map((run) => run.sessionEpoch)).toEqual([0, 0, 7]);
      expect(await readFile(path, "utf8")).toBe(original);
      await store.updateState(({ coordinator }) => {
        coordinator.circuits.omp = { failures: 1, openUntil: 0, probe: false };
      });
      expect(await readFile(`${path}.v${version}.bak`, "utf8")).toBe(original);
      const reopened = new RunStore(path);
      const migrated = await reopened.read();
      expect(defined(migrated.routines["rt-epoch"]).runs.map((run) => run.sessionEpoch)).toEqual([0, 0, 7]);
      expect(await reopened.get("run-process-marker")).toMatchObject({
        sessionEpoch: 0,
        providerTurnId: "turn-reused",
        executionStatus: "completed",
        taskOutcome: "unknown",
      });
      expect(await reopened.get(numeric.id)).toEqual(numeric);
    },
  );

  it("rejects a newly written string epoch without changing the authoritative snapshot", async () => {
    const store = new RunStore(path);
    await store.update((records) => {
      records.rt = { ...emptyRecord(), runs: [makeRun("current")] };
    });
    const original = await readFile(path, "utf8");
    await expect(
      store.update((records) => {
        defined(defined(records.rt).runs[0]).sessionEpoch = "ses-process-marker" as never;
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await new RunStore(path).get("current"))?.sessionEpoch).toBe(0);
  });
});

describe("managed history cannot silently disappear", () => {
  it.each([2, 3])(
    "fails closed for malformed v%i records and coordinator state on every entry point",
    async (version) => {
      const invalid = [
        `{"version":${version},"routines":{"rt":{"runs":[`,
        JSON.stringify({ version, routines: null, coordinator: { occurrences: {}, circuits: {} } }),
        JSON.stringify({
          version,
          routines: { rt: { lastRunAt: null, runs: [null] } },
          coordinator: { occurrences: {}, circuits: {} },
        }),
        JSON.stringify({
          version,
          routines: { rt: { lastRunAt: null, runs: "lost" } },
          coordinator: { occurrences: {}, circuits: {} },
        }),
        JSON.stringify({ version, routines: {}, coordinator: { occurrences: "lost", circuits: {} } }),
      ];
      for (const original of invalid) {
        await writeFile(path, original);
        const store = new RunStore(path);
        await expect(store.read()).rejects.toThrow("file left unchanged");
        await expect(store.list()).rejects.toThrow("file left unchanged");
        await expect(store.get("unknown")).rejects.toThrow("file left unchanged");
        await expect(store.rebuildIndex()).rejects.toThrow("file left unchanged");
        await expect(
          store.updateState(({ routines }) => {
            routines.new = emptyRecord();
          }),
        ).rejects.toThrow("file left unchanged");
        expect(await readFile(path, "utf8")).toBe(original);
        expect(await readdir(directory)).toEqual(["routines.json"]);
      }
    },
  );

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "refuses invalid persisted numeric generation %s in v2",
    async (sessionEpoch) => {
      const original = JSON.stringify({
        version: 2,
        routines: { rt: { lastRunAt: null, runs: [{ ...makeRun("invalid-epoch"), sessionEpoch }] } },
        coordinator: { occurrences: {}, circuits: {} },
      });
      await writeFile(path, original);
      await expect(new RunStore(path).read()).rejects.toThrow("file left unchanged");
      expect(await readFile(path, "utf8")).toBe(original);
    },
  );

  it("does not reinterpret a v3 process marker as legacy history", async () => {
    const original = JSON.stringify({
      version: 3,
      routines: {
        rt: { lastRunAt: null, runs: [{ ...makeRun("unexpected-process-marker"), sessionEpoch: "legacy" }] },
      },
      coordinator: { occurrences: {}, circuits: {} },
    });
    await writeFile(path, original);
    await expect(new RunStore(path).read()).rejects.toThrow("file left unchanged");
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("fair ordering of pre-v3 managed admissions", () => {
  it("assigns missing orders by original time and ID before new work without rewriting existing orders", async () => {
    const earliest = "2026-10-01T09:00:00.000Z";
    const later = "2026-10-01T09:05:00.000Z";
    const oldestA = oldQueuedRun("a-oldest", earliest);
    const oldestZ = oldQueuedRun("z-oldest", earliest);
    const latest = oldQueuedRun("latest-old", later);
    const existing = oldQueuedRun("existing-order", later, 7);
    const original = JSON.stringify({
      version: 2,
      routines: {
        z: { ...emptyRecord(), runs: [latest, existing] },
        a: { ...emptyRecord(), runs: [oldestZ, oldestA] },
      },
      coordinator: { occurrences: {}, circuits: {}, admissionOrder: 4 },
    });
    await writeFile(path, original);
    const store = new RunStore(path);
    const migrated = await store.read();
    expect(defined(migrated.routines.a).runs.map((run) => run.managed?.admissionOrder)).toEqual([9, 8]);
    expect(defined(migrated.routines.z).runs.map((run) => run.managed?.admissionOrder)).toEqual([10, 7]);
    expect(migrated.coordinator.admissionOrder).toBe(10);
    expect(await readFile(path, "utf8")).toBe(original);
    await store.updateState(({ routines, coordinator }) => {
      const run = oldQueuedRun("new-admission", later, ++coordinator.admissionOrder);
      routines.new = { ...emptyRecord(), runs: [run] };
      coordinator.occurrences[run.occurrenceKey] = run.id;
    });
    expect(await readFile(`${path}.v2.bak`, "utf8")).toBe(original);
    const reopened = new RunStore(path);
    expect((await reopened.get("a-oldest"))?.managed?.admissionOrder).toBe(8);
    expect((await reopened.get("z-oldest"))?.managed?.admissionOrder).toBe(9);
    expect((await reopened.get("new-admission"))?.managed?.admissionOrder).toBe(11);
    expect((await reopened.read()).coordinator.admissionOrder).toBe(11);
  });

  it("refuses exhausted ordering rather than wrapping or launching old work after a new admission", async () => {
    const original = JSON.stringify({
      version: 2,
      routines: {
        rt: { ...emptyRecord(), runs: [oldQueuedRun("missing-order", "2026-10-01T09:00:00.000Z")] },
      },
      coordinator: { occurrences: {}, circuits: {}, admissionOrder: Number.MAX_SAFE_INTEGER },
    });
    await writeFile(path, original);
    const store = new RunStore(path);
    await expect(store.read()).rejects.toThrow("admission order exhausted");
    await expect(store.updateState(() => {})).rejects.toThrow("admission order exhausted");
    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readdir(directory)).toEqual(["routines.json"]);
  });
});
