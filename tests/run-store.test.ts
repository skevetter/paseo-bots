import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { admitRun, appendRun, emptyRecord, KEEP_RUNS, RunStore } from "../server/run-store";
import { newSessionEpoch, SessionEpochSchema } from "../shared/runs";
import { defined, makeRun, useTempPaseoHome } from "./helpers";

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;

let file = 0;
function newStore(): RunStore {
  return new RunStore(join(pluginDataPath(), `routines-${++file}.json`));
}

async function storeFrom(text: string): Promise<RunStore> {
  const store = newStore();
  await mkdir(pluginDataPath(), { recursive: true });
  await writeFile(store.path, text);
  return store;
}

const setAside = async () =>
  (await readdir(pluginDataPath())).filter((name) => name.startsWith(`routines-${file}.json.corrupt-`));

const epoch = newSessionEpoch();
const admit = (trigger: "schedule" | "manual" = "manual") =>
  admitRun({ routineId: "rt", trigger, due: new Date("2026-10-01T09:00:00Z"), now: new Date(), epoch });

describe("run history saved before outcomes existed", () => {
  useTempPaseoHome("paseo-bots-run-store-migrate-");

  it("reads a completed turn as completed with an unknown outcome, never as a success", async () => {
    const original = await readFile(fixture("routines-v0.json"), "utf8");
    const store = await storeFrom(original);
    const { routines } = await store.read();

    const runs = defined(routines["rt-runs"]).runs;
    expect(runs.map((run) => [run.id, run.executionStatus, run.taskOutcome, run.skipped])).toEqual([
      ["run-aaaa1111", "completed", "unknown", null],
      ["run-bbbb2222", "failed", "unknown", null],
      ["run-cccc3333", "canceled", "unknown", "busy"],
      ["run-dddd4444", "canceled", "unknown", "missed"],
      ["run-eeee5555", "running", "unknown", null],
    ]);
    expect(runs[0]).toMatchObject({
      trigger: "schedule",
      agentId: "chat-1",
      output: "All 12 invoices sent.",
      endedAt: "2026-09-18T09:04:00.000Z",
      purpose: "task",
      sessionEpoch: 0,
      providerTurnId: null,
      parentRunId: null,
      verification: null,
    });
    expect(runs[0]).not.toHaveProperty("status");
    expect(runs.map((run) => run.occurrenceKey)).toEqual([
      "rt-runs@2026-09-18T09:00:00.000Z",
      "rt-runs#run-bbbb2222",
      "rt-runs#run-cccc3333",
      "rt-runs@2026-09-19T09:00:00.000Z",
      "rt-runs@2026-09-20T09:00:00.000Z",
    ]);

    // An entry that only kept its last run.
    expect(
      defined(routines["rt-single"]).runs.map((run) => [run.id, run.executionStatus, run.taskOutcome]),
    ).toEqual([["legacy", "completed", "unknown"]]);
    expect(routines["rt-null"]).toEqual({ lastRunAt: null, runs: [] });

    // Reading changes nothing on disk.
    expect(await readFile(store.path, "utf8")).toBe(original);
  });

  it("derives the same ids every time it reads the same file", async () => {
    const store = await storeFrom(await readFile(fixture("routines-v0.json"), "utf8"));
    const ids = async () =>
      defined((await store.read()).routines["rt-runs"]).runs.map((run) => [
        run.cycleId,
        run.attemptId,
        run.executionId,
      ]);
    const first = await ids();
    expect(await ids()).toEqual(first);
    expect(new Set(first.flat()).size).toBe(first.length * 3);
  });

  it("saves the new format on the first change and keeps the old file once", async () => {
    const original = await readFile(fixture("routines-v0.json"), "utf8");
    const store = await storeFrom(original);
    await store.update((routines) => {
      appendRun(defined(routines["rt-runs"]), admit());
    });

    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.routines["rt-runs"].runs).toHaveLength(6);
    expect(await readFile(`${store.path}.pre-run-store`, "utf8")).toBe(original);

    // A later change is on the new format already, so it leaves the backup alone.
    const { revision } = await store.read();
    await store.update((routines) => {
      appendRun(defined(routines["rt-runs"]), admit());
    });
    expect(await readFile(`${store.path}.pre-run-store`, "utf8")).toBe(original);
    expect((await store.read()).revision).not.toBe(revision);
  });

  it("reads what it saved back as the same runs", async () => {
    const store = await storeFrom(await readFile(fixture("routines-v0.json"), "utf8"));
    const before = (await store.read()).routines;
    await store.update(() => {});
    expect((await store.read()).routines).toEqual(before);
  });
});

describe("what the run store won't believe", () => {
  useTempPaseoHome("paseo-bots-run-store-trust-");

  it("reads a saved success nobody verified as an unknown outcome", async () => {
    const claimed = { ...makeRun("claimed"), taskOutcome: "verified_success" };
    const early = { ...makeRun("early"), executionStatus: "running", taskOutcome: "needs_review" };
    const store = await storeFrom(
      JSON.stringify({ version: 1, routines: { rt: { lastRunAt: null, runs: [claimed, early] } } }),
    );
    const runs = defined((await store.read()).routines.rt).runs;
    expect(runs.map((run) => [run.id, run.executionStatus, run.taskOutcome, run.verification])).toEqual([
      ["claimed", "completed", "unknown", null],
      ["early", "running", "unknown", null],
    ]);
  });

  it("refuses to save a success nobody verified and keeps what is on disk", async () => {
    const store = newStore();
    await store.update((routines) => {
      routines.rt = { ...emptyRecord(), runs: [makeRun("one")] };
    });
    const before = await readFile(store.path, "utf8");

    await expect(
      store.update((routines) => {
        const run = defined(routines.rt?.runs[0]);
        // A bot's reply that says "done, verified" doesn't set this; nothing in the store may either.
        run.taskOutcome = "verified_success";
      }),
    ).rejects.toThrow();
    expect(await readFile(store.path, "utf8")).toBe(before);

    // The failed save doesn't wedge the queue.
    await store.update((routines) => {
      appendRun(defined(routines.rt), makeRun("two"));
    });
    expect(defined((await store.read()).routines.rt).runs.map((run) => run.id)).toEqual(["one", "two"]);
  });

  it("drops a run it can't read, says which, and says it once", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = await storeFrom(
      JSON.stringify({
        version: 1,
        routines: {
          rt: { lastRunAt: null, runs: [makeRun("good"), { ...makeRun("bad"), executionStatus: "done" }] },
        },
      }),
    );
    expect(defined((await store.read()).routines.rt).runs.map((run) => run.id)).toEqual(["good"]);
    await store.read();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0]?.[0])).toContain("rt/bad");
    errors.mockRestore();
  });
});

describe("saving run history", () => {
  useTempPaseoHome("paseo-bots-run-store-cas-");

  it("saves only over the revision it read", async () => {
    const store = newStore();
    const first = await store.read();
    expect(first.routines).toEqual({});
    const saved = await store.write(first.revision, { rt: { ...emptyRecord(), runs: [makeRun("a")] } });
    expect(saved.status).toBe("saved");

    const stale = await store.write(first.revision, { rt: { ...emptyRecord(), runs: [makeRun("b")] } });
    expect(stale.status).toBe("conflict");
    expect(defined((await store.read()).routines.rt).runs.map((run) => run.id)).toEqual(["a"]);

    if (saved.status !== "saved") throw new Error("expected a saved write");
    expect(saved.revision).toBe((await store.read()).revision);
  });

  it("keeps every change when many are made at once", async () => {
    const store = newStore();
    const opened = await store.read();
    const changes = Array.from({ length: 12 }, (_, index) =>
      store.update((routines) => {
        const record = routines.rt ?? emptyRecord();
        appendRun(record, makeRun(`r-${index}`));
        routines.rt = record;
      }),
    );
    const late = store.write(opened.revision, { other: emptyRecord() });
    await Promise.all(changes);
    expect((await late).status).toBe("conflict");
    expect(defined((await store.read()).routines.rt).runs).toHaveLength(12);
  });

  it("keeps the latest runs of a routine", async () => {
    const record = emptyRecord();
    for (let index = 0; index < KEEP_RUNS + 5; index++) appendRun(record, makeRun(`r-${index}`));
    expect(record.runs).toHaveLength(KEEP_RUNS);
    expect(record.runs[0]?.id).toBe("r-5");
  });

  it("gives a scheduled occurrence the same key when it is admitted again, and a manual one its own", () => {
    const again = (trigger: "schedule" | "manual") => [
      admit(trigger).occurrenceKey,
      admit(trigger).occurrenceKey,
    ];
    const [first, second] = again("schedule");
    expect(first).toBe(second);
    expect(first).toBe("rt@2026-10-01T09:00:00.000Z");
    const [manualA, manualB] = again("manual");
    expect(manualA).not.toBe(manualB);
  });
});

describe("a broken run history file", () => {
  useTempPaseoHome("paseo-bots-run-store-broken-");

  it("is set aside, not overwritten", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = '{"rt": {"lastRunAt": "2026-09-2';
    const store = await storeFrom(broken);
    expect((await store.read()).routines).toEqual({});
    await store.update((routines) => {
      routines.rt = { ...emptyRecord(), runs: [makeRun("fresh")] };
    });
    const asides = await setAside();
    expect(asides).toHaveLength(1);
    expect(await readFile(join(pluginDataPath(), defined(asides[0])), "utf8")).toBe(broken);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("routines-"), expect.any(SyntaxError));
    errors.mockRestore();
  });

  it("refuses future history on every read and write without moving it away or running a change", async () => {
    const future = JSON.stringify({ version: 2, routines: {}, occurrences: [{ key: "x" }] });
    const store = await storeFrom(future);
    const change = vi.fn();
    await expect(store.read()).rejects.toThrow("Unsupported routine history version 2");
    await expect(store.read()).rejects.toThrow("file left unchanged");
    await expect(store.update(change)).rejects.toThrow("Unsupported routine history version 2");
    await expect(store.write("missing", {})).rejects.toThrow("Unsupported routine history version 2");
    await expect(new RunStore(store.path).update(change)).rejects.toThrow(
      "Unsupported routine history version 2",
    );
    expect(change).not.toHaveBeenCalled();
    expect(await readFile(store.path, "utf8")).toBe(future);
    expect(await setAside()).toEqual([]);
    expect(await readdir(pluginDataPath())).not.toContain(`routines-${file}.json.pre-run-store`);

    // Refusal doesn't wedge the queue. Recovery requires an explicit restore, not an automatic reset.
    await writeFile(store.path, JSON.stringify({ version: 1, routines: {} }));
    expect((await store.read()).routines).toEqual({});
  });

  it("leaves an old file and its backup alone when the first save is refused", async () => {
    const original = await readFile(fixture("routines-v0.json"), "utf8");
    const store = await storeFrom(original);
    await expect(
      store.update((routines) => {
        defined(routines["rt-runs"]).runs[0] = { ...makeRun("bad"), cycleId: "" as never };
      }),
    ).rejects.toThrow();
    expect(await readFile(store.path, "utf8")).toBe(original);
    expect(await readdir(pluginDataPath())).not.toContain(`routines-${file}.json.pre-run-store`);
  });
});

describe("persisted provider-session generations", () => {
  useTempPaseoHome("paseo-bots-session-generations-");

  it("migrates version-1 process markers to unknown without inventing provider sessions", async () => {
    const original = await readFile(fixture("routines-v1-process-epoch.json"), "utf8");
    const store = await storeFrom(original);
    const expected = JSON.parse(original).routines["rt-epoch"];
    expected.runs = expected.runs.map((run: Record<string, unknown>) => ({ ...run, sessionEpoch: 0 }));
    expect((await store.read()).routines["rt-epoch"]).toEqual(expected);
    expect(await readFile(store.path, "utf8")).toBe(original);
    await store.update(() => {});
    expect((await new RunStore(store.path).read()).routines["rt-epoch"]).toEqual(expected);
    expect(JSON.parse(await readFile(store.path, "utf8")).routines["rt-epoch"]).toEqual(expected);
  });

  it("keeps numeric generations across reopen and advances only from the persisted previous value", async () => {
    const store = newStore();
    await store.update((routines) => {
      routines.rt = {
        lastRunAt: null,
        runs: [
          makeRun("observed", { sessionEpoch: newSessionEpoch() }),
          makeRun("upper-bound", { sessionEpoch: SessionEpochSchema.parse(Number.MAX_SAFE_INTEGER) }),
        ],
      };
    });
    const reopened = new RunStore(store.path);
    expect(defined((await reopened.read()).routines.rt).runs.map((run) => run.sessionEpoch)).toEqual([
      1,
      Number.MAX_SAFE_INTEGER,
    ]);
    await reopened.update((routines) => {
      const run = defined(routines.rt?.runs[0]);
      run.sessionEpoch = newSessionEpoch(run.sessionEpoch);
    });
    const reopenedAgain = new RunStore(store.path);
    expect(defined((await reopenedAgain.read()).routines.rt).runs[0]?.sessionEpoch).toBe(2);
    expect(defined((await reopenedAgain.read()).routines.rt).runs[0]?.sessionEpoch).toBe(2);
  });
});

describe("invalid persisted generation transitions", () => {
  useTempPaseoHome("paseo-bots-invalid-generations-");

  it("refuses invalid writes without replacing valid history", async () => {
    const store = newStore();
    await store.update((routines) => {
      routines.rt = { lastRunAt: null, runs: [makeRun("existing", { sessionEpoch: newSessionEpoch(4) })] };
    });
    const before = await readFile(store.path, "utf8");
    for (const invalid of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "7"]) {
      await expect(
        store.update((routines) => {
          Object.assign(defined(routines.rt?.runs[0]), { sessionEpoch: invalid });
        }),
      ).rejects.toThrow();
      expect(await readFile(store.path, "utf8")).toBe(before);
    }
    expect(defined((await store.read()).routines.rt).runs[0]?.sessionEpoch).toBe(5);
  });

  it("does not repair invalid numeric epochs into an observed or unknown session", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const runs = [
      makeRun("known", { sessionEpoch: newSessionEpoch(6) }),
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((sessionEpoch, index) => ({
        ...makeRun(`invalid-${index}`),
        sessionEpoch,
      })),
    ];
    const store = await storeFrom(
      JSON.stringify({ version: 1, routines: { rt: { lastRunAt: null, runs } } }),
    );
    const loaded = defined((await store.read()).routines.rt).runs;
    expect(loaded.map((run) => [run.id, run.sessionEpoch])).toEqual([["known", 7]]);
    expect(errors).toHaveBeenCalledTimes(1);
    errors.mockRestore();
  });
});
