import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as files from "../server/files";
import { ManagedAgentClaims } from "../server/managed-agent-claims";
import { RunArtifacts } from "../server/run-artifacts";
import { emptyRecord, RunStore } from "../server/run-store";
import { CoordinatorStateSchema, ManagedRunSchema } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { makePrepared } from "./coordinator-fixture";
import { defined, makeRun } from "./helpers";

let directory: string;
let path: string;
let namespace: string;
let coverage: string;

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "paseo-managed-agent-claims-")));
  path = join(directory, "routines.json");
  namespace = `${path}.managed-agents`;
  coverage = join(namespace, "coverage.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

function claimPath(agentId: string): string {
  const id = createHash("sha256").update(JSON.stringify(agentId)).digest("hex");
  return join(namespace, `${id}.json`);
}

async function managedRun(agentId: string, previous: string[] = []): Promise<RoutineRun> {
  const prepared = makePrepared({ agentId });
  const artifact = await new RunArtifacts(directory).put({ prepared, capacity: {} });
  const run = makeRun(`run-${agentId}`, { agentId });
  run.managed = ManagedRunSchema.parse({
    botId: prepared.botId,
    routineId: "rt",
    requestId: `request-${agentId}`,
    artifact,
    provider: prepared.provider,
    model: prepared.model,
    systemPromptHash: prepared.metadata.systemPromptHash,
    userPromptHash: prepared.metadata.userPromptHash,
    environmentVersion: prepared.metadata.environmentVersion,
    resourceIds: [],
    overlap: "queue",
    reservation: true,
    notBefore: 0,
    attempts: [...previous, agentId].map((id, index) => ({
      agentId: id,
      attemptId: `att-${index}`,
      executionId: `exe-${index}`,
      idempotencyKey: `create-${index}`,
      number: index + 1,
      state: index === 0 ? "unknown" : "completed",
      error: null,
    })),
    timeline: null,
    creation: null,
    cancelRequested: false,
    coalescedInto: null,
  });
  return run;
}

async function saveHistory(version = 3, previous = ["old-completed", "old-unknown"]): Promise<string> {
  const run = await managedRun("current", previous);
  const raw = `${JSON.stringify(
    {
      version,
      routines: { rt: { ...emptyRecord(), runs: [run] } },
      coordinator: CoordinatorStateSchema.parse({ occurrences: {}, circuits: {} }),
    },
    null,
    "\t",
  )}\n\n`;
  await writeFile(path, raw);
  return raw;
}

describe("read-only classification before historical coverage", () => {
  it.each([1, 2, 3])(
    "reads v%i real launch artifacts and all attempts without changing history or modes",
    async (version) => {
      const raw = await saveHistory(version);
      const orphan = makePrepared({ agentId: "retained-orphan" });
      const artifact = await new RunArtifacts(directory).put({ prepared: orphan });
      const artifactPath = join(directory, "run-artifacts", `${artifact.id}.json`);
      await chmod(artifactPath, 0o400);
      const before = await stat(path);
      const artifactBefore = await stat(artifactPath);
      const names = await readdir(directory);
      const store = new RunStore(path);
      for (const id of ["current", "old-completed", "old-unknown", "retained-orphan"])
        expect(await store.isManagedAgent(id)).toBe(true);
      expect(await store.isManagedAgent("unrelated")).toBe(false);
      expect(await readFile(path, "utf8")).toBe(raw);
      expect((await stat(path)).ino).toBe(before.ino);
      expect((await stat(artifactPath)).mode).toBe(artifactBefore.mode);
      expect(await readdir(directory)).toEqual(names);
      await expect(stat(namespace)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("proves a pristine first-load negative without creating directories or metadata", async () => {
    expect(await new RunStore(path).isManagedAgent("unrelated")).toBe(false);
    const uncreated = new RunStore(join(directory, "not-created", "routines.json"));
    expect(await uncreated.isManagedAgent("unrelated")).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(["", "not an envelope", "{}", '{"version":3,"routines":', '{"version":99,"routines":{}}'])(
    "refuses damaged precoverage history %s without moving it aside",
    async (raw) => {
      await writeFile(path, raw);
      const store = new RunStore(path);
      await expect(store.isManagedAgent("unrelated")).rejects.toThrow();
      await expect(store.backfillManagedAgentClaims()).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(raw);
      expect(await readdir(directory)).toEqual(["routines.json"]);
    },
  );

  it("refuses a dropped legacy managed row instead of certifying incomplete coverage", async () => {
    const raw = JSON.parse(await saveHistory(1));
    raw.routines.rt.runs[0].managed.attempts[0].agentId = null;
    const bytes = JSON.stringify(raw);
    await writeFile(path, bytes);
    await expect(new RunStore(path).isManagedAgent("unrelated")).rejects.toThrow();
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(bytes);
    await expect(stat(namespace)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires intact metadata even if surviving artifacts identify one managed candidate", async () => {
    await saveHistory();
    await rm(path);
    await expect(new RunStore(path).isManagedAgent("unrelated")).rejects.toThrow("recovery");
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow("backfill");
    await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serves trustworthy negatives while first-load backfill owns the writer queue", async () => {
    const raw = await saveHistory(1);
    await writeFile(join(directory, "coordinator.lock"), "current startup owner");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const publish = files.publishDurableExclusive;
    vi.spyOn(files, "publishDurableExclusive").mockImplementation(async (target, text, mode) => {
      if (target === claimPath("current")) {
        entered();
        await blocked;
      }
      await publish(target, text, mode);
    });
    const store = new RunStore(path);
    const bootstrap = store.backfillManagedAgentClaims();
    await started;
    try {
      expect(await store.isManagedAgent("unrelated")).toBe(false);
      expect(await store.isManagedAgent("old-unknown")).toBe(true);
      expect(await readFile(path, "utf8")).toBe(raw);
      await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release();
      await bootstrap;
    }
  });
});

describe("durable historical coverage", () => {
  it.each([1, 2, 3])(
    "backfills v%i without rewriting source or taking an upgrade backup until an explicit write",
    async (version) => {
      const raw = await saveHistory(version);
      const before = await stat(path);
      const store = new RunStore(path);
      await store.backfillManagedAgentClaims();
      expect(await readFile(path, "utf8")).toBe(raw);
      expect((await stat(path)).ino).toBe(before.ino);
      await expect(stat(`${path}.v${version}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
      const reopened = new RunStore(path);
      for (const id of ["current", "old-completed", "old-unknown"])
        expect(await reopened.isManagedAgent(id)).toBe(true);
      expect(await reopened.isManagedAgent("unrelated")).toBe(false);
      expect((await stat(namespace)).mode & 0o777).toBe(0o700);
      expect((await stat(coverage)).mode & 0o777).toBe(0o600);
      expect((await stat(claimPath("current"))).mode & 0o777).toBe(0o600);
      await store.update(() => {});
      if (version < 3) expect(await readFile(`${path}.v${version}.bak`, "utf8")).toBe(raw);
      expect(await new RunStore(path).isManagedAgent("old-unknown")).toBe(true);
    },
  );

  it.each(["future", "corrupt", "missing", "symlink"])(
    "isolates exact negatives from %s main metadata and foreign coordinator locks",
    async (damage) => {
      await saveHistory();
      await new RunStore(path).backfillManagedAgentClaims();
      if (damage === "future") await writeFile(path, '{"version":900,"routines":{}}');
      else if (damage === "corrupt") await writeFile(path, "broken history");
      else {
        await rm(path);
        if (damage === "symlink") await symlink(join(directory, "nonexistent-history"), path);
      }
      await writeFile(join(directory, "coordinator.lock"), "foreign or stale owner");
      const reopened = new RunStore(path);
      expect(await reopened.isManagedAgent("unrelated")).toBe(false);
      for (const id of ["current", "old-completed", "old-unknown"])
        expect(await reopened.isManagedAgent(id)).toBe(true);
    },
  );

  it("does not wait for an in-flight metadata writer", async () => {
    const store = new RunStore(path);
    await store.initialize();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = store.update(async () => {
      entered();
      await blocked;
    });
    await started;
    try {
      expect(await store.isManagedAgent("unrelated")).toBe(false);
    } finally {
      release();
      await write;
    }
  });
});

describe("durable claim publication boundaries", () => {
  it("retains current and historical obligations beyond display retention and explicit metadata deletion", async () => {
    const store = new RunStore(path);
    await store.initialize();
    const run = await managedRun("current", ["old-completed", "old-unknown"]);
    await store.update((records) => {
      records.rt = {
        ...emptyRecord(),
        runs: [run, ...Array.from({ length: 40 }, (_, n) => makeRun(`terminal-${n}`))],
      };
    });
    await store.update((records) => {
      delete records.rt;
    });
    const reopened = new RunStore(path);
    for (const id of ["current", "old-completed", "old-unknown"])
      expect(await reopened.isManagedAgent(id)).toBe(true);
    expect(await reopened.isManagedAgent("ordinary-agent")).toBe(false);
  });

  it("claims IDs from retained backups and unreferenced launch artifacts", async () => {
    const old = await saveHistory(1, ["backup-attempt"]);
    await writeFile(`${path}.v1.bak`, old);
    await writeFile(
      path,
      JSON.stringify({ version: 3, routines: {}, coordinator: { occurrences: {}, circuits: {} } }),
    );
    await new RunStore(path).backfillManagedAgentClaims();
    expect(await new RunStore(path).isManagedAgent("backup-attempt")).toBe(true);
    expect(await new RunStore(path).isManagedAgent("current")).toBe(true);
    expect(await readFile(`${path}.v1.bak`, "utf8")).toBe(old);
  });

  it("preserves opaque historical IDs without path traversal or UTF-8 hash collisions", async () => {
    const store = new RunStore(path);
    await store.initialize();
    for (const id of ["../old/id\u0000 東京", "", "\ud800", "\ud801"]) {
      const run = await managedRun(id);
      await store.update((records) => {
        records.rt = { ...emptyRecord(), runs: [run] };
      });
    }
    const reopened = new RunStore(path);
    for (const id of ["../old/id\u0000 東京", "", "\ud800", "\ud801"])
      expect(await reopened.isManagedAgent(id)).toBe(true);
    expect(await reopened.isManagedAgent("../old/id\u0000 京都")).toBe(false);
    expect(claimPath("\ud800")).not.toBe(claimPath("\ud801"));
  });
});

describe("publication ordering and interrupted backfill", () => {
  it("has durable claims before authoritative metadata publication and leaves an orphan obligation on failure", async () => {
    const store = new RunStore(path);
    await store.initialize();
    const original = await readFile(path, "utf8");
    const run = await managedRun("not-published", ["prior-attempt"]);
    let observed = false;
    vi.spyOn(files, "writeDurableAtomic").mockImplementationOnce(async (target) => {
      expect(target).toBe(path);
      const reopened = new RunStore(path);
      expect(await reopened.isManagedAgent("not-published")).toBe(true);
      expect(await reopened.isManagedAgent("prior-attempt")).toBe(true);
      expect(JSON.parse(await readFile(claimPath("not-published"), "utf8"))).toEqual({
        version: 1,
        kind: "paseo-bots-managed-agent-claim",
        path,
        agentId: "not-published",
      });
      observed = true;
      throw new Error("Interrupted before metadata publication");
    });
    await expect(
      store.update((records) => {
        records.rt = { ...emptyRecord(), runs: [run] };
      }),
    ).rejects.toThrow("Interrupted");
    expect(observed).toBe(true);
    expect(await readFile(path, "utf8")).toBe(original);
    const reopened = new RunStore(path);
    expect(await reopened.isManagedAgent("not-published")).toBe(true);
    expect(await reopened.get(run.id)).toBeNull();
  });

  it("does not publish completion after a claim failure and safely replays existing synced claims", async () => {
    const raw = await saveHistory();
    const publish = files.publishDurableExclusive;
    const before: Record<string, number> = {};
    const fault = vi
      .spyOn(files, "publishDurableExclusive")
      .mockImplementation(async (target, text, mode) => {
        if (target === claimPath("old-unknown")) throw new Error("Interrupted historical claim");
        await publish(target, text, mode);
        before[target] = (await stat(target)).ino;
      });
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow(
      "Interrupted historical claim",
    );
    await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path, "utf8")).toBe(raw);
    expect(await new RunStore(path).isManagedAgent("unrelated")).toBe(false);
    fault.mockRestore();
    await new RunStore(path).backfillManagedAgentClaims();
    for (const [target, inode] of Object.entries(before)) expect((await stat(target)).ino).toBe(inode);
    expect(await new RunStore(path).isManagedAgent("old-unknown")).toBe(true);
    expect(await new RunStore(path).isManagedAgent("unrelated")).toBe(false);
  });

  it("refuses metadata publication over a corrupted cached claim rather than trusting the published-ID cache", async () => {
    const store = new RunStore(path);
    await store.initialize();
    const run = await managedRun("current");
    await store.update((records) => {
      records.rt = { ...emptyRecord(), runs: [run] };
    });
    const original = await readFile(path, "utf8");
    await writeFile(claimPath("current"), "damaged cached claim");
    await expect(
      store.update((records) => {
        defined(records.rt).runs[0] = { ...run, output: "should not save" };
      }),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(original);
  });
});

describe("damaged private coverage never becomes absence", () => {
  it.each(["empty", "future", "symlink", "permissions"])(
    "rejects a %s completion marker without repairing it",
    async (damage) => {
      await saveHistory();
      await new RunStore(path).backfillManagedAgentClaims();
      const original = await readFile(coverage, "utf8");
      if (damage === "empty") await writeFile(coverage, "");
      if (damage === "future") await writeFile(coverage, original.replace('"version":1', '"version":2'));
      if (damage === "symlink") {
        await rm(coverage);
        await symlink(join(directory, "missing-marker"), coverage);
      }
      if (damage === "permissions") await chmod(coverage, 0o000);
      const store = new RunStore(path);
      await expect(store.isManagedAgent("unrelated")).rejects.toThrow();
      await expect(store.isManagedAgent("current")).rejects.toThrow();
      await expect(store.backfillManagedAgentClaims()).rejects.toThrow();
    },
  );

  it.each(["bytes", "future", "symlink", "permissions"])(
    "rejects %s at the exact claimed path, including a cold read",
    async (damage) => {
      await saveHistory();
      const store = new RunStore(path);
      await store.backfillManagedAgentClaims();
      const target = claimPath("current");
      if (damage === "bytes") await writeFile(target, "invalid");
      if (damage === "future")
        await writeFile(target, (await readFile(target, "utf8")).replace('"version":1', '"version":2'));
      if (damage === "symlink") {
        await rm(target);
        await symlink(join(directory, "missing-claim"), target);
      }
      if (damage === "permissions") await chmod(target, 0o000);
      await expect(store.isManagedAgent("current")).rejects.toThrow();
      await expect(new RunStore(path).isManagedAgent("current")).rejects.toThrow();
      expect(await new RunStore(path).isManagedAgent("unrelated")).toBe(false);
    },
  );

  it("rejects a substituted symlink namespace", async () => {
    await mkdir(join(directory, "redirect"));
    await symlink(join(directory, "redirect"), namespace);
    await expect(new RunStore(path).isManagedAgent("unrelated")).rejects.toThrow();
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow();
    expect(await readdir(join(directory, "redirect"))).toEqual([]);
  });

  it("does not reseal an unsupported orphan claim namespace", async () => {
    await saveHistory();
    await mkdir(namespace);
    await writeFile(claimPath("orphan"), '{"version":2,"agentId":"orphan"}');
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow();
    await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses damaged retained artifacts before publishing a completion marker", async () => {
    await saveHistory();
    const artifacts = join(directory, "run-artifacts");
    const name = defined((await readdir(artifacts))[0]);
    await writeFile(join(artifacts, name), '{"prepared":{"agentId":"lost"}}');
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow(
      "damaged retained artifact",
    );
    await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps a standalone orphan claim positive without inventing a receipt or an empty namespace", async () => {
    const claims = new ManagedAgentClaims(path);
    await claims.publish(["orphan"]);
    expect(await new RunStore(path).isManagedAgent("orphan")).toBe(true);
    await expect(new RunStore(path).isManagedAgent("unrelated")).rejects.toThrow("backfill");
    await expect(new RunStore(path).backfillManagedAgentClaims()).rejects.toThrow("backfill");
    await expect(stat(coverage)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
