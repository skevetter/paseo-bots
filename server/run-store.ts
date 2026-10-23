import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type CoordinatorState, CoordinatorStateSchema } from "../shared/managed-runs";
import { type RoutineRecord, RoutineRecordSchema, type RoutineRun, RoutineRunShape } from "../shared/rpc";
import {
  fromLegacyStatus,
  isTerminal,
  newAttemptId,
  newCycleId,
  newExecutionId,
  newRunId,
  occurrenceKeyOf,
  runStateIssue,
  type SessionEpoch,
  type Trigger,
} from "../shared/runs";
import { pluginDataPath } from "./bot-home";
import { readParsed, UnsupportedFileVersionError, writeAtomic } from "./files";

// The only reader and writer of routines.json. Writes are serialized, replace the file atomically, and
// save only over the revision they were made from, like state.ts does for bots.

const VERSION = 2;
/** Runs kept per routine. */
export const KEEP_RUNS = 30;
/** Where runs saved before the store had a version are kept, once, so an older plugin can be put back. */
const BACKUP_SUFFIX = ".pre-run-store";

export type Records = Record<string, RoutineRecord>;

export interface RunSnapshot {
  revision: string;
  routines: Records;
  coordinator: CoordinatorState;
}

export type RunWrite = ({ status: "saved" } & RunSnapshot) | { status: "conflict"; error: string };

interface Loaded extends RunSnapshot {
  /** The file had no version: it holds the shape saved before the store existed. */
  unversioned: boolean;
  dropped: string[];
  version: number | null;
}

interface UnsupportedVersion {
  unsupportedVersion: number;
}

const EnvelopeSchema = z.object({
  version: z.literal(VERSION),
  routines: z.record(z.string(), RoutineRecordSchema),
  coordinator: CoordinatorStateSchema,
});

export const emptyRecord = (): RoutineRecord => ({ lastRunAt: null, runs: [] });

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Ids for a run saved without any are derived from the run, so reading it twice gives the same ids. */
const derivedId = (prefix: string, routineId: string, runId: string) =>
  `${prefix}-${hash(`${prefix}\0${routineId}\0${runId}`).slice(0, 32)}`;

/** A run saved before ids and outcomes existed. Its label said the turn completed, never that the task worked. */
function upgradeRun(routineId: string, raw: Record<string, unknown>): Record<string, unknown> {
  const { status, ...rest } = raw;
  const id = typeof raw.id === "string" ? raw.id : "";
  return {
    ...rest,
    ...fromLegacyStatus(status),
    cycleId: derivedId("cyc", routineId, id),
    attemptId: derivedId("att", routineId, id),
    executionId: derivedId("exe", routineId, id),
    sessionEpoch: "legacy",
    occurrenceKey: occurrenceKeyOf(routineId, String(raw.trigger), String(raw.scheduledFor), id),
    parentRunId: null,
    providerTurnId: null,
    purpose: "task",
    verification: null,
  };
}

/**
 * A pair of facts that can't both be true is repaired to an unknown outcome rather than believed.
 * A run that can't be read at all is dropped and named.
 */
function readRun(routineId: string, raw: unknown, dropped: string[]): RoutineRun[] {
  if (!isObject(raw)) return [];
  const candidate = "executionStatus" in raw ? raw : upgradeRun(routineId, raw);
  const parsed = RoutineRunShape.safeParse(candidate);
  if (!parsed.success) {
    dropped.push(`${routineId}/${String(raw.id)}: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
    return [];
  }
  const run = parsed.data;
  return [runStateIssue(run) ? { ...run, taskOutcome: "unknown", verification: null } : run];
}

/** Entries saved by the oldest versions kept only the last run. */
function readRecord(routineId: string, entry: unknown, dropped: string[]): RoutineRecord {
  if (!isObject(entry)) return emptyRecord();
  const lastRunAt = typeof entry.lastRunAt === "string" ? entry.lastRunAt : null;
  if (Array.isArray(entry.runs))
    return { lastRunAt, runs: entry.runs.flatMap((run) => readRun(routineId, run, dropped)) };
  if (!lastRunAt) return emptyRecord();
  const run = {
    id: "legacy",
    trigger: "schedule",
    scheduledFor: lastRunAt,
    startedAt: lastRunAt,
    endedAt: null,
    status: entry.lastStatus,
    agentId: typeof entry.lastAgentId === "string" ? entry.lastAgentId : null,
    output: null,
    error: typeof entry.lastError === "string" ? entry.lastError : null,
  };
  return { lastRunAt, runs: readRun(routineId, run, dropped) };
}

class UnsafeRunHistoryError extends UnsupportedFileVersionError {
  constructor(message: string) {
    super(VERSION);
    this.message = `Run history requires explicit repair; file left unchanged: ${message}`;
  }
}

function parse(raw: string): Loaded | UnsupportedVersion {
  const saved: unknown = decodeHistory(raw);
  if (!isObject(saved)) throw new Error("Routine history isn't an object");
  const versioned = typeof saved.version === "number";
  // This is readable data from another version, not corruption. Let load refuse it outside readParsed's
  // corruption recovery so a downgrade can't move it away and silently create an empty history.
  if (typeof saved.version === "number" && saved.version !== 1 && saved.version !== VERSION)
    return { unsupportedVersion: saved.version };
  const entries = versioned ? saved.routines : saved;
  if (!isObject(entries)) throw new Error("Routine history has no routines");
  const dropped: string[] = [];
  const routines: Records = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [id, readRecord(id, entry, dropped)]),
  );
  const coordinator = readCoordinator(saved, dropped, routines);
  return {
    revision: hash(raw),
    routines,
    coordinator,
    unversioned: !versioned,
    version: versioned ? Number(saved.version) : null,
    dropped,
  };
}

function decodeHistory(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    // Managed writers put the version first; losing that history must never free unknown reservations.
    const version = /^\s*\{\s*"version"\s*:\s*(\d+)/.exec(raw)?.[1];
    if (version && Number(version) >= VERSION) throw new UnsafeRunHistoryError("malformed managed history");
    throw error;
  }
}

function readCoordinator(
  saved: Record<string, unknown>,
  dropped: string[],
  routines: Records,
): CoordinatorState {
  const parsed = CoordinatorStateSchema.safeParse(saved.coordinator);
  if (saved.version === VERSION && (!parsed.success || dropped.length > 0))
    throw new UnsafeRunHistoryError("unreadable coordinator state or managed execution");
  const coordinator =
    saved.version === VERSION && parsed.success ? parsed.data : { occurrences: {}, circuits: {} };
  for (const record of Object.values(routines))
    for (const run of record.runs) coordinator.occurrences[run.occurrenceKey] ??= run.id;
  return coordinator;
}

/** Retention never discards unfinished work, unknown effects, or a live reservation. */
export function appendRun(record: RoutineRecord, run: RoutineRun): void {
  record.runs.push(run);
  pruneRuns(record);
}

function pruneRuns(record: RoutineRecord): void {
  let remaining = KEEP_RUNS;
  record.runs = record.runs
    .toReversed()
    .filter((entry) => {
      if (
        !isTerminal(entry.executionStatus) ||
        entry.executionStatus === "unknown" ||
        entry.managed?.reservation
      )
        return true;
      return remaining-- > 0;
    })
    .reverse();
}

/** A new run in its own cycle with its first attempt and execution. */
export function admitRun(input: {
  routineId: string;
  trigger: Trigger;
  due: Date;
  now: Date;
  epoch: SessionEpoch;
}): RoutineRun {
  const id = newRunId();
  return {
    id,
    cycleId: newCycleId(),
    attemptId: newAttemptId(),
    executionId: newExecutionId(),
    sessionEpoch: input.epoch,
    occurrenceKey: occurrenceKeyOf(input.routineId, input.trigger, input.due.toISOString(), id),
    parentRunId: null,
    providerTurnId: null,
    purpose: "task",
    trigger: input.trigger,
    scheduledFor: input.due.toISOString(),
    startedAt: input.now.toISOString(),
    endedAt: null,
    executionStatus: "running",
    taskOutcome: "unknown",
    verification: null,
    skipped: null,
    agentId: null,
    output: null,
    error: null,
  };
}

/** Run history by routine. `write` saves only over the revision it names; `update` reads, changes and saves in one step. */
export class RunStore {
  private queue: Promise<unknown> = Promise.resolve();
  /** The file revision whose unreadable runs were last reported, so polling doesn't repeat the report. */
  private reported = "";

  constructor(readonly path = join(pluginDataPath(), "routines.json")) {}

  async read(): Promise<RunSnapshot> {
    const { revision, routines, coordinator } = await this.serial(() => this.load());
    return { revision, routines, coordinator };
  }

  write(revision: string, routines: Records): Promise<RunWrite> {
    return this.serial(async () => {
      const loaded = await this.load();
      if (loaded.revision !== revision)
        return { status: "conflict", error: "Run history changed elsewhere. Reload before saving again." };
      return { status: "saved", ...(await this.persist(loaded, routines)) };
    });
  }

  /** `change` edits the records in place and may return a value. */
  update<T>(change: (routines: Records) => T | Promise<T>): Promise<T> {
    return this.updateState(({ routines }) => change(routines));
  }

  updateState<T>(change: (state: RunSnapshot) => T | Promise<T>): Promise<T> {
    return this.serial(async () => {
      const loaded = await this.load();
      const result = await change(loaded);
      await this.persist(loaded, loaded.routines);
      return result;
    });
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  private async load(): Promise<Loaded> {
    const loaded = await readParsed(this.path, parse);
    if (!loaded)
      return {
        revision: "missing",
        routines: {},
        coordinator: { occurrences: {}, circuits: {} },
        unversioned: false,
        version: VERSION,
        dropped: [],
      };
    if ("unsupportedVersion" in loaded)
      throw new Error(
        `Unsupported routine history version ${loaded.unsupportedVersion} at ${this.path}; file left unchanged. Use a compatible plugin or explicitly restore a backup.`,
      );
    if (loaded.dropped.length > 0 && this.reported !== loaded.revision) {
      this.reported = loaded.revision;
      console.error(`paseo-bots: dropped unreadable runs from ${this.path}:\n${loaded.dropped.join("\n")}`);
    }
    return loaded;
  }

  private async persist(loaded: Loaded, routines: Records): Promise<RunSnapshot> {
    for (const record of Object.values(routines)) pruneRuns(record);
    const envelope = EnvelopeSchema.parse({ version: VERSION, routines, coordinator: loaded.coordinator });
    const raw = JSON.stringify(envelope, null, 2);
    if (loaded.unversioned)
      await copyFile(this.path, `${this.path}${BACKUP_SUFFIX}`, constants.COPYFILE_EXCL).catch(
        (error: unknown) => {
          if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        },
      );
    if (loaded.version === 1) {
      await copyFile(this.path, `${this.path}.v1.bak`, constants.COPYFILE_EXCL).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      });
    }
    await writeAtomic(this.path, raw, 0o600);
    const file = await open(this.path, "r");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(dirname(this.path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return { revision: hash(raw), routines: envelope.routines, coordinator: envelope.coordinator };
  }
}
