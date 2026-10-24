import { mkdir, readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { RunStore } from "../server/run-store";
import { RoutineRunCardSchema, RoutineRunSchema } from "../shared/rpc";
import { defined, makeRun, useTempPaseoHome } from "./helpers";

const verification = {
  verifier: { id: "source-revision", digest: "a".repeat(64) },
  at: "2026-10-02T13:01:00.000Z",
};

describe("deterministic no-work outcome boundaries", () => {
  it("requires pinned verification even when the execution completed", () => {
    const run = { ...makeRun("no-work"), taskOutcome: "no_change" };
    expect(RoutineRunSchema.safeParse(run).success).toBe(false);
    expect(
      RoutineRunSchema.safeParse({
        ...run,
        verification: {
          ...verification,
          verifier: { id: "source-revision", digest: "not-pinned" },
        },
      }).success,
    ).toBe(false);
    expect(RoutineRunSchema.parse({ ...run, verification })).toEqual({ ...run, verification });
  });

  it.each(["failed", "canceled"])("does not equate %s execution with verified no work", (executionStatus) => {
    const run = { ...makeRun("not-completed"), executionStatus, taskOutcome: "no_change" };
    expect(RoutineRunSchema.safeParse(run).success).toBe(false);
    expect(RoutineRunSchema.safeParse({ ...run, verification }).success).toBe(false);
  });
});

describe("version-1 no-change history migration", () => {
  useTempPaseoHome("paseo-bots-no-change-migration-");

  it("keeps the entire history but repairs unsupported no-change claims without inventing verification", async () => {
    const original = await readFile(
      new URL("./fixtures/routines-v1-unverified-no-change.json", import.meta.url).pathname,
      "utf8",
    );
    const backup = await readFile(new URL("./fixtures/routines-v0.json", import.meta.url).pathname, "utf8");
    const store = new RunStore();
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(store.path, original);
    await writeFile(`${store.path}.pre-run-store`, backup);
    const expected = JSON.parse(original).routines;
    expected["rt-no-change"].runs = expected["rt-no-change"].runs.map((run: Record<string, unknown>) => ({
      ...run,
      taskOutcome: run.id === "run-verified-completion" ? "no_change" : "unknown",
    }));

    const migrated = await store.read();
    expect(migrated.routines).toEqual(expected);
    expect((await store.read()).routines).toEqual(expected);
    expect(await readFile(store.path, "utf8")).toBe(original);
    await store.update(() => {});
    expect((await new RunStore(store.path).read()).routines).toEqual(expected);
    expect(JSON.parse(await readFile(store.path, "utf8"))).toEqual({ version: 1, routines: expected });
    expect(await readFile(`${store.path}.pre-run-store`, "utf8")).toBe(backup);

    // A new unsupported claim is refused, not silently migrated at the write boundary.
    const saved = await readFile(store.path, "utf8");
    await expect(
      store.update((routines) => {
        defined(routines["rt-no-change"]?.runs[0]).taskOutcome = "no_change";
      }),
    ).rejects.toThrow();
    expect(await readFile(store.path, "utf8")).toBe(saved);
  });
});

describe("persisted no-change result cards", () => {
  const card = {
    routineName: "Check",
    trigger: "manual",
    scheduledFor: "2026-10-02T13:00:00.000Z",
    executionStatus: "completed",
    taskOutcome: "no_change",
    skipped: null,
    agentId: "agent",
    output: "Nothing to do",
    error: null,
  };

  it("reads unverified completion as unknown without hiding the card or its output", () => {
    expect(RoutineRunCardSchema.parse(card)).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      verification: null,
      output: "Nothing to do",
    });
    expect(RoutineRunCardSchema.parse({ ...card, verification })).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "no_change",
      verification,
    });
  });

  it.each(["failed", "canceled"])(
    "does not present %s execution as a successful deterministic check",
    (executionStatus) => {
      expect(RoutineRunCardSchema.parse({ ...card, executionStatus, verification })).toMatchObject({
        executionStatus,
        taskOutcome: "unknown",
        verification: null,
      });
    },
  );
});
