import fsPromises, { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunArtifacts } from "../server/run-artifacts";
import { emptyRecord, type RunSnapshot, RunStore } from "../server/run-store";
import { EXECUTION_LABEL, ManagedRunSchema, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { SessionEpochSchema } from "../shared/runs";
import { makePrepared } from "./coordinator-fixture";
import { defined, makeRun } from "./helpers";

let directory: string;
let path: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-run-store-durability-")));
  path = join(directory, "routines.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await rm(directory, { recursive: true, force: true });
});

function source(version: number | null): string {
  const record = { lastRunAt: null, runs: [makeRun("retained-original", { output: "Résumé 東京" })] };
  return `${JSON.stringify(
    version === null
      ? { rt: record }
      : {
          version,
          routines: { rt: record },
          ...(version >= 2 ? { coordinator: { occurrences: {}, circuits: {} } } : {}),
        },
    null,
    "\t",
  )}\n\n`;
}

const MIGRATIONS = [
  { label: "unversioned", version: null, suffix: ".pre-run-store" },
  { label: "v1", version: 1, suffix: ".v1.bak" },
  { label: "v2", version: 2, suffix: ".v2.bak" },
];

describe("exclusive migration backup integrity", () => {
  it.each(MIGRATIONS)(
    "refuses a partial $label migration backup without changing source or backup",
    async ({ version, suffix }) => {
      const original = source(version);
      const backup = `${path}${suffix}`;
      const partial = original.slice(0, Math.floor(original.length / 2));
      await writeFile(path, original);
      await writeFile(backup, partial);
      const before = await stat(backup);
      const store = new RunStore(path);
      expect((await store.get("retained-original"))?.output).toBe("Résumé 東京");
      await expect(
        store.update((records) => {
          records.added = emptyRecord();
        }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await readFile(backup, "utf8")).toBe(partial);
      expect((await stat(backup)).ino).toBe(before.ino);
      expect((await readdir(directory)).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    },
  );

  it.each(MIGRATIONS)(
    "refuses an empty $label migration backup instead of trusting its pathname",
    async ({ version, suffix }) => {
      const original = source(version);
      await writeFile(path, original);
      await writeFile(`${path}${suffix}`, "");
      await expect(
        new RunStore(path).update((records) => {
          records.added = emptyRecord();
        }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(original);
      expect(await readFile(`${path}${suffix}`, "utf8")).toBe("");
    },
  );
});

describe("reusing an exact migration backup", () => {
  it.each(MIGRATIONS)(
    "accepts an exact existing $label backup without replacing its inode or original bytes",
    async ({ version, suffix }) => {
      const original = source(version);
      const backup = `${path}${suffix}`;
      await writeFile(path, original);
      await writeFile(backup, original);
      const before = await stat(backup);
      await new RunStore(path).update((records) => {
        defined(records.rt).runs.push(makeRun("after-migration"));
      });
      const reopened = new RunStore(path);
      expect((await reopened.list()).runs.map((run) => run.id).sort()).toEqual([
        "after-migration",
        "retained-original",
      ]);
      await reopened.update((records) => {
        records.other = emptyRecord();
      });
      expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
      expect(await readFile(backup, "utf8")).toBe(original);
      expect((await stat(backup)).ino).toBe(before.ino);
    },
  );
});

describe("migration compare-and-swap at publication", () => {
  it.each(MIGRATIONS)(
    "preserves an external $label replacement made during the async update callback",
    async ({ version, suffix }) => {
      const original = source(version);
      const external = `${original} `;
      await writeFile(path, original);
      const store = new RunStore(path);
      await expect(
        store.update(async (records) => {
          await writeFile(path, external);
          records.added = emptyRecord();
        }),
      ).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(external);
      await expect(stat(`${path}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readdir(directory)).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    },
  );
});

interface ManagedHistory {
  store: RunStore;
  run: RoutineRun;
  bytes: Buffer;
  snapshot: RunSnapshot;
}

async function managedHistory(): Promise<ManagedHistory> {
  const store = new RunStore(path);
  await store.initialize();
  const plan = makePrepared();
  const run = makeRun("unknown-reservation", {
    executionStatus: "unknown",
    endedAt: null,
    agentId: plan.agentId,
    sessionEpoch: SessionEpochSchema.parse(1),
    error: "Creation acknowledgement lost",
  });
  plan.labels[RUN_LABEL] = run.id;
  plan.labels[EXECUTION_LABEL] = run.executionId;
  plan.clientMessageId = run.executionId;
  const artifact = await new RunArtifacts(directory).put({ prepared: plan });
  run.managed = ManagedRunSchema.parse({
    botId: plan.botId,
    routineId: "rt",
    requestId: "durable-request",
    artifact,
    provider: plan.provider,
    model: plan.model,
    systemPromptHash: plan.metadata.systemPromptHash,
    userPromptHash: plan.metadata.userPromptHash,
    environmentVersion: plan.metadata.environmentVersion,
    resourceIds: ["mailbox:shared"],
    overlap: "queue",
    reservation: true,
    notBefore: 0,
    clientMessageId: run.executionId,
    attempts: [
      {
        attemptId: run.attemptId,
        executionId: run.executionId,
        agentId: plan.agentId,
        idempotencyKey: plan.idempotencyKey,
        number: 1,
        state: "unknown",
        error: run.error,
      },
    ],
    timeline: null,
    creation: { key: plan.idempotencyKey, revision: 1, phase: "failed", outcomeUnknown: true },
    cancelRequested: true,
    cancelError: "Host cancellation unsupported",
    coalescedInto: null,
    launchIntent: true,
    requestHash: "a".repeat(64),
    admissionOrder: 1,
    admittedAt: Date.parse(run.startedAt),
  });
  await store.updateState(({ routines, coordinator }) => {
    routines.rt = { ...emptyRecord(), runs: [run] };
    coordinator.occurrences[run.occurrenceKey] = run.id;
    coordinator.admissionOrder = 1;
    coordinator.circuits[plan.provider] = { failures: 2, openUntil: 30_000, probe: false };
  });
  await store.list();
  await store.get(run.id);
  await store.rebuildIndex();
  return { store, run, bytes: await readFile(path), snapshot: await store.read() };
}

async function assertFilePreserved(expected: Buffer | null): Promise<void> {
  if (expected === null) await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  else expect(await readFile(path)).toEqual(expected);
  expect((await readdir(directory)).filter((name) => name.includes(".corrupt-"))).toEqual([]);
}

async function assertClosed(store: RunStore, expected: Buffer | null): Promise<void> {
  let callbackRan = false;
  const operations = [
    () => store.read(),
    () => store.list(),
    () => store.get("unknown-reservation"),
    () => store.rebuildIndex(),
    () => store.initialize(),
    () =>
      store.update((records) => {
        callbackRan = true;
        records.overwritten = emptyRecord();
      }),
    () =>
      store.updateState((state) => {
        callbackRan = true;
        state.routines.overwritten = emptyRecord();
      }),
  ];
  for (const operation of operations) {
    await expect(operation()).rejects.toThrow();
    await assertFilePreserved(expected);
  }
  expect(callbackRan).toBe(false);
}

const LOST_HISTORY = [
  { label: "missing", bytes: null },
  { label: "empty", bytes: Buffer.from("") },
  { label: "garbage", bytes: Buffer.from("lost metadata without a version prefix") },
  { label: "empty JSON object", bytes: Buffer.from("{}") },
  {
    label: "invalid UTF-8",
    bytes: Buffer.concat([
      Buffer.from('{"version":3,"routines":{},"coordinator":{"occurrences":{},"circuits":{},"note":"'),
      Buffer.from([0xff]),
      Buffer.from('"}}'),
    ]),
  },
];

describe("initialized managed history is authoritative", () => {
  it.each(LOST_HISTORY)(
    "refuses $label metadata through every cached and reopened API until exact restoration",
    async ({ bytes }) => {
      const saved = await managedHistory();
      if (bytes === null) await rm(path);
      else await writeFile(path, bytes);
      await assertClosed(saved.store, bytes);
      await assertClosed(new RunStore(path), bytes);
      await writeFile(path, saved.bytes);
      const reopened = new RunStore(path);
      expect(await reopened.get(saved.run.id)).toEqual(saved.run);
      expect((await reopened.read()).coordinator).toEqual(saved.snapshot.coordinator);
      expect((await reopened.list()).runs).toEqual([saved.run]);
      const artifact = await new RunArtifacts(directory).get<{ prepared: { agentId: string } }>(
        defined(saved.run.managed).artifact,
      );
      expect(artifact.prepared.agentId).toBe(saved.run.agentId);
      expect((await reopened.get(saved.run.id))?.managed?.reservation).toBe(true);
    },
  );

  it.each([2, 3])(
    "seals recognized v%i on read before exposing it, then refuses an erased envelope",
    async (version) => {
      const original = source(version);
      await writeFile(path, original);
      const store = new RunStore(path);
      expect((await store.get("retained-original"))?.output).toBe("Résumé 東京");
      expect((await stat(`${path}.initialized`)).isFile()).toBe(true);
      expect(await readFile(path, "utf8")).toBe(original);
      await writeFile(path, "{}");
      await assertClosed(new RunStore(path), Buffer.from("{}"));
    },
  );
});

describe("ambiguous history without a valid seal", () => {
  it.each(["empty", "garbage"] as const)(
    "refuses a %s existing seal even when authoritative v3 metadata is valid",
    async (kind) => {
      const saved = await managedHistory();
      const markerBytes = Buffer.from(kind === "empty" ? "" : "not a sealed initialization record");
      await writeFile(`${path}.initialized`, markerBytes);
      await assertClosed(new RunStore(path), saved.bytes);
      expect(await readFile(`${path}.initialized`)).toEqual(markerBytes);
    },
  );

  it.each(LOST_HISTORY)(
    "refuses $label metadata with prior immutable artifacts even when the seal was removed",
    async ({ bytes }) => {
      const saved = await managedHistory();
      await rm(`${path}.initialized`);
      if (bytes === null) await rm(path);
      else await writeFile(path, bytes);
      await assertClosed(new RunStore(path), bytes);
      const artifact = await new RunArtifacts(directory).get<{ prepared: { agentId: string } }>(
        defined(saved.run.managed).artifact,
      );
      expect(artifact.prepared.agentId).toBe(saved.run.agentId);
      await expect(stat(`${path}.initialized`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(MIGRATIONS)(
    "refuses lost metadata when only its $label migration backup remains",
    async ({ version, suffix }) => {
      const original = source(version);
      await writeFile(path, original);
      await new RunStore(path).initialize();
      const backup = `${path}${suffix}`;
      expect(await readFile(backup, "utf8")).toBe(original);
      const before = await stat(backup);
      await rm(path);
      await rm(`${path}.initialized`);
      await assertClosed(new RunStore(path), null);
      expect(await readFile(backup, "utf8")).toBe(original);
      expect((await stat(backup)).ino).toBe(before.ino);
    },
  );
});

describe("legacy malformed data recovery", () => {
  it("preserves set-aside legacy bytes and requires explicit intact restoration before new coverage", async () => {
    const original = Buffer.from('{"old legacy data":');
    await writeFile(path, original);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const store = new RunStore(path);
    try {
      expect((await store.read()).routines).toEqual({});
      const names = (await readdir(directory)).filter((name) => name.startsWith("routines.json.corrupt-"));
      expect(names).toHaveLength(1);
      const aside = join(directory, defined(names[0]));
      expect(await readFile(aside)).toEqual(original);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.isManagedAgent("unrelated")).rejects.toThrow();
      await expect(store.backfillManagedAgentClaims()).rejects.toThrow();
      await writeFile(path, JSON.stringify({ version: 1, routines: {} }));
      await store.backfillManagedAgentClaims();
      await store.update((records) => {
        records.recovered = { ...emptyRecord(), runs: [makeRun("after-legacy-repair")] };
      });
      expect((await new RunStore(path).get("after-legacy-repair"))?.executionStatus).toBe("completed");
      expect(await readFile(aside)).toEqual(original);
    } finally {
      log.mockRestore();
    }
  });
});

interface SyncInterruption {
  readonly interrupted: boolean;
  restore(): void;
}

function interruptAfterRealSync(when: (filePath: string) => boolean | Promise<boolean>): SyncInterruption {
  const realOpen = fsPromises.open;
  let interrupted = false;
  const opened = vi.spyOn(fsPromises, "open").mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const realSync = handle.sync.bind(handle);
    handle.sync = async () => {
      await realSync();
      if (!interrupted && (await when(String(args[0])))) {
        interrupted = true;
        throw new Error("Injected interruption after real filesystem sync");
      }
    };
    return handle;
  });
  syncBuiltinESMExports();
  return {
    get interrupted() {
      return interrupted;
    },
    restore() {
      opened.mockRestore();
      syncBuiltinESMExports();
    },
  };
}

describe("first metadata publication failure", () => {
  it("leaves no authoritative file when its staged bytes were synced but publication did not happen", async () => {
    const fault = interruptAfterRealSync(
      (candidate) =>
        dirname(candidate) === directory && candidate !== path && !candidate.includes(".initialized"),
    );
    try {
      await expect(
        new RunStore(path).update((records) => {
          records.rt = { ...emptyRecord(), runs: [makeRun("not-published")] };
        }),
      ).rejects.toThrow("Injected interruption");
      expect(fault.interrupted).toBe(true);
    } finally {
      fault.restore();
    }
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${path}.initialized`)).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = new RunStore(path);
    await reopened.update((records) => {
      records.rt = { ...emptyRecord(), runs: [makeRun("published-after-retry")] };
    });
    expect((await new RunStore(path).list()).runs.map((run) => run.id)).toEqual(["published-after-retry"]);
  });

  it("does not leave a trusted partial migration backup after a real backup-stage sync failure", async () => {
    const original = source(1);
    const backup = `${path}.v1.bak`;
    await writeFile(path, original);
    const fault = interruptAfterRealSync(
      (candidate) =>
        dirname(candidate) === directory && candidate.includes(".v1.bak") && candidate !== backup,
    );
    try {
      await expect(
        new RunStore(path).update((records) => {
          records.added = emptyRecord();
        }),
      ).rejects.toThrow("Injected interruption");
      expect(fault.interrupted).toBe(true);
    } finally {
      fault.restore();
    }
    expect(await readFile(path, "utf8")).toBe(original);
    await expect(stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
    await new RunStore(path).update((records) => {
      records.added = emptyRecord();
    });
    expect(await readFile(backup, "utf8")).toBe(original);
    expect((await new RunStore(path).get("retained-original"))?.output).toBe("Résumé 東京");
  });
});

describe("initialization seal publication crash windows", () => {
  it("recovers validated durable v3 bytes when interruption precedes seal publication", async () => {
    const marker = `${path}.initialized`;
    const fault = interruptAfterRealSync(
      (candidate) =>
        dirname(candidate) === directory && candidate.includes(".initialized") && candidate !== marker,
    );
    try {
      await expect(new RunStore(path).initialize()).rejects.toThrow("Injected interruption");
      expect(fault.interrupted).toBe(true);
    } finally {
      fault.restore();
    }
    const durable = await readFile(path);
    expect(JSON.parse(durable.toString("utf8"))).toMatchObject({ version: 3, routines: {} });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    const reopened = new RunStore(path);
    expect((await reopened.read()).routines).toEqual({});
    expect(await readFile(path)).toEqual(durable);
    expect((await stat(marker)).isFile()).toBe(true);
    const saved = await managedHistory();
    expect((await new RunStore(path).get(saved.run.id))?.managed).toEqual(saved.run.managed);
  });

  it("reuses a completely published seal after its directory sync reports interruption", async () => {
    const marker = `${path}.initialized`;
    const fault = interruptAfterRealSync(async (candidate) => {
      if (candidate !== directory) return false;
      const present = await stat(marker).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
        return null;
      });
      return present?.isFile() ?? false;
    });
    try {
      await expect(new RunStore(path).initialize()).rejects.toThrow("Injected interruption");
      expect(fault.interrupted).toBe(true);
    } finally {
      fault.restore();
    }
    const sourceBytes = await readFile(path);
    const sourceInode = (await stat(path)).ino;
    const markerBytes = await readFile(marker);
    const before = await stat(marker);
    const reopened = new RunStore(path);
    await reopened.initialize();
    expect((await reopened.read()).routines).toEqual({});
    expect(await readFile(path)).toEqual(sourceBytes);
    expect((await stat(path)).ino).toBe(sourceInode);
    expect(await readFile(marker)).toEqual(markerBytes);
    expect((await stat(marker)).ino).toBe(before.ino);
  });
});

describe("initialized history cannot be silently downgraded", () => {
  it.each([null, 0, 1])(
    "refuses legacy version %s substituted under an existing managed seal",
    async (version) => {
      await managedHistory();
      const legacy = Buffer.from(source(version));
      await writeFile(path, legacy);
      await assertClosed(new RunStore(path), legacy);
      await expect(stat(`${path}.pre-run-store`)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(`${path}.v1.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("refuses even valid artifact-backed v1 coordinator data substituted beneath an actual seal", async () => {
    const saved = await managedHistory();
    const envelope: Record<string, unknown> = JSON.parse(saved.bytes.toString("utf8"));
    envelope.version = 1;
    const replacement = Buffer.from(JSON.stringify(envelope));
    await writeFile(path, replacement);
    await assertClosed(new RunStore(path), replacement);
    const artifact = defined(saved.run.managed).artifact;
    expect(await new RunArtifacts(directory).get<{ prepared: { agentId: string } }>(artifact)).toMatchObject({
      prepared: { agentId: saved.run.agentId },
    });
  });
});

describe("unsealed backup-only history cannot be reset as legacy", () => {
  it.each(
    MIGRATIONS.flatMap((migration) => [
      { ...migration, loss: "garbage", bytes: Buffer.from("unrecognizable metadata") },
      { ...migration, loss: "empty JSON object", bytes: Buffer.from("{}") },
    ]),
  )(
    "refuses $loss metadata when the $label backup proves prior history",
    async ({ version, suffix, bytes }) => {
      const original = source(version);
      await writeFile(path, original);
      await new RunStore(path).initialize();
      const backup = `${path}${suffix}`;
      const before = await stat(backup);
      await rm(`${path}.initialized`);
      await writeFile(path, bytes);
      await assertClosed(new RunStore(path), bytes);
      expect(await readFile(backup, "utf8")).toBe(original);
      expect((await stat(backup)).ino).toBe(before.ino);
    },
  );
});

describe("malformed managed run rows fail closed", () => {
  it("refuses an unsealed v3 history with a malformed managed run row", async () => {
    const envelope = {
      version: 3,
      routines: { rt: { lastRunAt: null, runs: [{ ...makeRun("malformed-row"), startedAt: 12 }] } },
      coordinator: { occurrences: {}, circuits: {} },
    };
    const bytes = Buffer.from(`${JSON.stringify(envelope, null, "\t")}\n`);
    await writeFile(path, bytes);
    await assertClosed(new RunStore(path), bytes);
  });
});
