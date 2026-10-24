import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunArtifacts } from "../server/run-artifacts";
import { appendRun, emptyRecord, RunStore } from "../server/run-store";
import { type ManagedRun, ManagedRunSchema } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { defined, makeRun } from "./helpers";

const START = "2026-10-01T09:00:00.000Z";
let directory: string;
let path: string;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-run-history-"));
  path = join(directory, "routines.json");
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function managedRun(id: string, patch: Partial<ManagedRun> = {}): RoutineRun {
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
    ...patch,
  });
  return makeRun(id, { startedAt: START, managed });
}

describe("historical metadata and private evidence", () => {
  it("retains routine and ordinary details beyond 30 rows through reopen and index rebuild", async () => {
    const store = new RunStore(path);
    await store.initialize();
    const artifacts = new RunArtifacts(directory);
    const admitted = await artifacts.put({ model: "frozen-model", prompt: "original input" });
    const result = await artifacts.put({ reply: "complete private result", evidence: ["receipt-1"] });
    const routines = Array.from({ length: 36 }, (_, index) =>
      managedRun(`routine-${index}`, {
        artifact: admitted,
        result,
      }),
    );
    const ordinary = Array.from({ length: 36 }, (_, index) =>
      managedRun(`ordinary-${index}`, {
        routineId: null,
        artifact: admitted,
        result,
      }),
    );
    await store.update((records) => {
      records["routine-a"] = { ...emptyRecord(), runs: routines };
      records["ordinary-record"] = { ...emptyRecord(), runs: ordinary };
    });
    const originalBytes = await readFile(path, "utf8");
    const reopened = new RunStore(path);
    await reopened.rebuildIndex();
    const actual: RoutineRun[] = [];
    let cursor: string | undefined;
    do {
      const page = await reopened.list({ cursor, limit: 17 });
      actual.push(...page.runs);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(actual.map((run) => run.id).sort()).toEqual(
      [...routines, ...ordinary].map((run) => run.id).sort(),
    );
    expect(await reopened.get("routine-0")).toEqual(routines[0]);
    expect(await reopened.get("ordinary-0")).toEqual(ordinary[0]);
    const historic = defined(await reopened.get("routine-0"));
    expect(await artifacts.get(defined(historic.managed).artifact)).toEqual({
      model: "frozen-model",
      prompt: "original input",
    });
    expect(await artifacts.get(defined(defined(historic.managed).result))).toEqual({
      reply: "complete private result",
      evidence: ["receipt-1"],
    });
    expect(await readFile(path, "utf8")).toBe(originalBytes);
  });
});

describe("authoritative history filters", () => {
  it("combines bot, routine and status filters using managed metadata and durable legacy receipts", async () => {
    const store = new RunStore(path);
    const failed = managedRun("managed-failure");
    failed.executionStatus = "failed";
    const ordinary = managedRun("ordinary", { routineId: null });
    const otherBot = managedRun("other-bot", { botId: "bot-b" });
    const legacy = makeRun("legacy-failure", { startedAt: START, executionStatus: "failed" });
    const unowned = makeRun("legacy-without-owner", { startedAt: START, executionStatus: "failed" });
    await store.updateState(({ routines, coordinator }) => {
      routines["routine-a"] = { ...emptyRecord(), runs: [failed, otherBot, legacy, unowned] };
      routines["ordinary-record"] = { ...emptyRecord(), runs: [ordinary] };
      coordinator.requests[legacy.occurrenceKey] = {
        runId: legacy.id,
        recordId: "routine-a",
        botId: "bot-a",
        requestHash: null,
        mode: "legacy",
      };
    });
    const filtered = await store.list({ botId: "bot-a", routineId: "routine-a", executionStatus: "failed" });
    expect(filtered.runs.map((run) => run.id)).toEqual(["managed-failure", "legacy-failure"]);
    expect((await store.list({ botId: "bot-a" })).runs.map((run) => run.id)).toEqual([
      "ordinary",
      "managed-failure",
      "legacy-failure",
    ]);
    expect((await store.list({ routineId: "routine-a" })).runs.map((run) => run.id)).toEqual([
      "other-bot",
      "managed-failure",
      "legacy-without-owner",
      "legacy-failure",
    ]);
    expect(await store.get("missing")).toBeNull();
  });

  it("invalidates cached ordering and status filters when an independent store commits a new revision", async () => {
    const first = new RunStore(path);
    await first.update((records) => {
      records["routine-a"] = { ...emptyRecord(), runs: [managedRun("original")] };
    });
    expect((await first.list({ executionStatus: "completed" })).runs.map((run) => run.id)).toEqual([
      "original",
    ]);
    const second = new RunStore(path);
    await second.update((records) => {
      defined(defined(records["routine-a"]).runs[0]).executionStatus = "failed";
      appendRun(defined(records["routine-a"]), managedRun("newer"));
    });
    expect((await first.list({ executionStatus: "completed" })).runs.map((run) => run.id)).toEqual(["newer"]);
    expect((await first.list({ executionStatus: "failed" })).runs.map((run) => run.id)).toEqual(["original"]);
    const historical = defined(await first.get("original"));
    historical.output = "caller-only mutation";
    expect((await first.get("original"))?.output).toBeNull();
  });
});

describe("stable opaque history pages", () => {
  it("continues from timestamp/run/record key without repeats when new records precede the cursor", async () => {
    const store = new RunStore(path);
    await store.update((records) => {
      records.a = { ...emptyRecord(), runs: [managedRun("a"), managedRun("b"), managedRun("c")] };
    });
    const first = await store.list({ limit: 2 });
    expect(first.runs.map((run) => run.id)).toEqual(["c", "b"]);
    const cursor = defined(first.nextCursor);
    expect(["c", "b"]).not.toContain(cursor);
    await store.update((records) => {
      appendRun(defined(records.a), managedRun("d"));
    });
    const next = await new RunStore(path).list({ limit: 2, cursor });
    expect(next.runs.map((run) => run.id)).toEqual(["a"]);
    expect(next.nextCursor).toBeNull();
  });

  it("uses record identity to page equal historical IDs and refuses an ambiguous get", async () => {
    const store = new RunStore(path);
    const a = makeRun("historic-collision", { startedAt: START, output: "record-a" });
    const b = makeRun("historic-collision", { startedAt: START, output: "record-b" });
    await store.update((records) => {
      records["record-a"] = { ...emptyRecord(), runs: [a] };
      records["record-b"] = { ...emptyRecord(), runs: [b] };
    });
    const first = await store.list({ limit: 1 });
    expect(first.runs.map((run) => run.output)).toEqual(["record-b"]);
    const next = await new RunStore(path).list({ limit: 1, cursor: defined(first.nextCursor) });
    expect(next.runs.map((run) => run.output)).toEqual(["record-a"]);
    expect(next.nextCursor).toBeNull();
    await expect(store.get(a.id)).rejects.toThrow("ambiguous");
    expect((await store.list({ routineId: "record-a" })).runs).toEqual([a]);
  });

  it.each([
    "not-an-opaque-cursor",
    "../escape",
    Buffer.from('{"version":1,"key":[1]}').toString("base64url"),
  ])("rejects malformed cursor %s rather than restarting history silently", async (cursor) => {
    await expect(new RunStore(path).list({ cursor })).rejects.toThrow("Invalid run history cursor");
  });
});

describe("one authoritative writer across store instances", () => {
  it("serializes awaited updates through real and symlinked directory aliases without losing history", async () => {
    const actual = join(directory, "actual");
    const alias = join(directory, "alias");
    await mkdir(actual);
    await symlink(actual, alias);
    const stores = [new RunStore(join(actual, "routines.json")), new RunStore(join(alias, "routines.json"))];
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        defined(stores[index % 2]).update(async (records) => {
          active++;
          maximum = Math.max(maximum, active);
          const record = records.rt ?? emptyRecord();
          await setImmediate();
          appendRun(record, makeRun(`concurrent-${index}`));
          records.rt = record;
          active--;
        }),
      ),
    );
    expect(maximum).toBe(1);
    expect(
      defined((await defined(stores[0]).read()).routines.rt)
        .runs.map((run) => run.id)
        .sort(),
    ).toEqual(Array.from({ length: 12 }, (_, index) => `concurrent-${index}`).sort());
  });

  it("applies compare-and-swap across independent instances sharing a canonical metadata path", async () => {
    const first = new RunStore(path);
    const second = new RunStore(path);
    const before = await first.read();
    const results = await Promise.all([
      first.write(before.revision, { first: { ...emptyRecord(), runs: [makeRun("first")] } }),
      second.write(before.revision, { second: { ...emptyRecord(), runs: [makeRun("second")] } }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const saved = results.find((result) => result.status === "saved");
    if (saved?.status !== "saved") throw new Error("Expected one successful history write");
    expect((await new RunStore(path).read()).routines).toEqual(saved.routines);
  });
});
