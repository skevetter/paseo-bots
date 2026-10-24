import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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
import {
  publishDurableExclusive,
  readParsed,
  UnsupportedFileVersionError,
  writeDurableAtomic,
} from "./files";
import { type RunHistoryFilter, RunHistoryIndex, type RunHistoryPage } from "./run-history-index";
import {
  inspectHistorySeal,
  RunHistoryIntegrityError,
  readHistoryText,
  requireRecognizableHistory,
  sealHistory,
} from "./run-history-seal";

export type { RunHistoryFilter, RunHistoryPage } from "./run-history-index";

// The only reader and writer of routines.json. Writes are serialized, replace the file atomically, and
// save only over the revision they were made from, like state.ts does for bots.

const VERSION = 3;
const MANAGED_VERSION = 2;
/** Unprotected terminal rows in the old-client display projection, never an evidence-retention cap. */
export const KEEP_RUNS = 30;
/** Where runs saved before the store had a version are kept, once, so an older plugin can be put back. */
const BACKUP_SUFFIX = ".pre-run-store";
const writerQueues = new Map<string, Promise<unknown>>();

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
  raw: string | null;
  sealed: boolean;
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
    sessionEpoch: 0,
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
function readRun(routineId: string, raw: unknown, dropped: string[], migrateEpoch: boolean): RoutineRun[] {
  if (!isObject(raw)) {
    dropped.push(`${routineId}: unreadable run`);
    return [];
  }
  const candidate = "executionStatus" in raw ? { ...raw } : upgradeRun(routineId, raw);
  if (migrateEpoch && typeof candidate.sessionEpoch === "string") candidate.sessionEpoch = 0;
  const parsed = RoutineRunShape.safeParse(candidate);
  if (!parsed.success) {
    dropped.push(`${routineId}/${String(raw.id)}: ${parsed.error.issues[0]?.message ?? "unreadable"}`);
    return [];
  }
  const run = parsed.data;
  return [runStateIssue(run) ? { ...run, taskOutcome: "unknown", verification: null } : run];
}

/** Entries saved by the oldest versions kept only the last run. */
function readRecord(
  routineId: string,
  entry: unknown,
  dropped: string[],
  envelope: Record<string, unknown>,
): RoutineRecord {
  const version = typeof envelope.version === "number" ? envelope.version : null;
  const strict = managedFormat(envelope);
  if (strict && !validManagedRecord(entry)) throw new UnsafeRunHistoryError(`unreadable record ${routineId}`);
  if (!isObject(entry)) return emptyRecord();
  const lastRunAt = typeof entry.lastRunAt === "string" ? entry.lastRunAt : null;
  if (Array.isArray(entry.runs))
    return {
      lastRunAt,
      runs: entry.runs.flatMap((run) => readRun(routineId, run, dropped, version !== VERSION)),
    };
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
  return { lastRunAt, runs: readRun(routineId, run, dropped, true) };
}

function validManagedRecord(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.runs)) return false;
  return (
    (entry.lastRunAt === null || typeof entry.lastRunAt === "string") &&
    entry.runs.every((run) => isObject(run) && "executionStatus" in run)
  );
}

function managedFormat(envelope: Record<string, unknown>): boolean {
  return (
    typeof envelope.version === "number" &&
    (envelope.version >= MANAGED_VERSION || envelope.coordinator !== undefined)
  );
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
  if (typeof saved.version === "number" && ![0, 1, MANAGED_VERSION, VERSION].includes(saved.version))
    return { unsupportedVersion: saved.version };
  const entries = versioned ? saved.routines : saved;
  if (!isObject(entries)) {
    if (managedFormat(saved)) throw new UnsafeRunHistoryError("unreadable managed records");
    throw new Error("Routine history has no routines");
  }
  const dropped: string[] = [];
  const routines: Records = Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [id, readRecord(id, entry, dropped, saved)]),
  );
  const coordinator = readCoordinator(saved, dropped, routines);
  normalizeAdmissionOrder(routines, coordinator, saved.version !== VERSION);
  return {
    raw,
    sealed: false,
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
    if (version && Number(version) >= MANAGED_VERSION)
      throw new UnsafeRunHistoryError("malformed managed history");
    throw error;
  }
}

function readCoordinator(
  saved: Record<string, unknown>,
  dropped: string[],
  routines: Records,
): CoordinatorState {
  const parsed = CoordinatorStateSchema.safeParse(saved.coordinator);
  const managed = managedFormat(saved);
  if (managed && (!parsed.success || dropped.length > 0))
    throw new UnsafeRunHistoryError("unreadable coordinator state or managed execution");
  const coordinator = parsed.success
    ? parsed.data
    : CoordinatorStateSchema.parse({ occurrences: {}, circuits: {} });
  for (const record of Object.values(routines))
    for (const run of record.runs) coordinator.occurrences[run.occurrenceKey] ??= run.id;
  return coordinator;
}

function normalizeAdmissionOrder(
  routines: Records,
  coordinator: CoordinatorState,
  assignMissing: boolean,
): void {
  let order = coordinator.admissionOrder;
  for (const record of Object.values(routines))
    for (const run of record.runs) order = Math.max(order, run.managed?.admissionOrder ?? 0);
  coordinator.admissionOrder = order;
  if (!assignMissing) return;
  const pending = Object.entries(routines).flatMap(([recordId, record]) =>
    record.runs.flatMap((run) =>
      run.managed && run.managed.admissionOrder === undefined
        ? [{ recordId, run, managed: run.managed }]
        : [],
    ),
  );
  pending.sort(
    (a, b) =>
      a.run.startedAt.localeCompare(b.run.startedAt) ||
      a.run.id.localeCompare(b.run.id) ||
      a.recordId.localeCompare(b.recordId),
  );
  for (const { managed } of pending) {
    if (order === Number.MAX_SAFE_INTEGER)
      throw new UnsafeRunHistoryError("managed admission order exhausted");
    managed.admissionOrder = ++order;
  }
  coordinator.admissionOrder = order;
}

/** Append to authoritative evidence; displayRecords is the only bounded projection. */
export function appendRun(record: RoutineRecord, run: RoutineRun): void {
  record.runs.push(run);
}

/** Old-client status stays small without deleting detailed history or protected evidence. */
export function displayRecords(records: Records): Records {
  return structuredClone(
    Object.fromEntries(
      Object.entries(records).map(([id, record]) => {
        let remaining = KEEP_RUNS;
        const runs = record.runs
          .toReversed()
          .filter((run) => {
            if (!isTerminal(run.executionStatus) || run.executionStatus === "unknown") return true;
            if (run.managed?.reservation || run.managed?.evidencePins?.length) return true;
            return remaining-- > 0;
          })
          .reverse();
        return [id, { ...record, runs }];
      }),
    ),
  );
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
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
  readonly path: string;
  private readonly index = new RunHistoryIndex();
  /** The file revision whose unreadable runs were last reported, so polling doesn't repeat the report. */
  private reported = "";

  constructor(path = join(pluginDataPath(), "routines.json")) {
    this.path = resolve(path);
  }

  /** Establish durable history and its seal before publishing private execution artifacts. */
  initialize(): Promise<void> {
    return this.serial(async (path) => {
      const loaded = await this.load(path);
      if (loaded.revision === "missing" || loaded.version !== VERSION)
        await this.persist(loaded, loaded.routines, path);
    });
  }
  async read(): Promise<RunSnapshot> {
    const { revision, routines, coordinator } = await this.serial((path) => this.load(path));
    return { revision, routines, coordinator };
  }

  list(filter: RunHistoryFilter = {}): Promise<RunHistoryPage> {
    return this.serial(async (path) => this.index.list(await this.load(path), filter));
  }

  get(runId: string): Promise<RoutineRun | null> {
    return this.serial(async (path) => this.index.get(await this.load(path), runId));
  }

  rebuildIndex(): Promise<void> {
    return this.serial(async (path) => this.index.rebuild(await this.load(path)));
  }

  write(revision: string, routines: Records): Promise<RunWrite> {
    return this.serial(async (path) => {
      const loaded = await this.load(path);
      if (loaded.revision !== revision)
        return { status: "conflict", error: "Run history changed elsewhere. Reload before saving again." };
      return { status: "saved", ...(await this.persist(loaded, routines, path)) };
    });
  }

  /** `change` edits the records in place and may return a value. */
  update<T>(change: (routines: Records) => T | Promise<T>): Promise<T> {
    return this.updateState(({ routines }) => change(routines));
  }

  updateState<T>(change: (state: RunSnapshot) => T | Promise<T>): Promise<T> {
    return this.serial(async (path) => {
      const loaded = await this.load(path);
      const result = await change(loaded);
      await this.persist(loaded, loaded.routines, path);
      return result;
    });
  }

  private async serial<T>(work: (path: string) => Promise<T>): Promise<T> {
    const path = await canonicalPath(this.path);
    const next = (writerQueues.get(path) ?? Promise.resolve()).then(() => work(path));
    writerQueues.set(
      path,
      next.catch(() => {}),
    );
    return next;
  }

  private async load(path: string): Promise<Loaded> {
    const safety = await inspectHistorySeal(path);
    const raw = await readHistoryText(path);
    const loaded = await this.parseLoaded(path, raw, safety);
    if (!loaded)
      return {
        revision: "missing",
        routines: {},
        coordinator: CoordinatorStateSchema.parse({ occurrences: {}, circuits: {} }),
        unversioned: false,
        version: VERSION,
        dropped: [],
        raw: null,
        sealed: false,
      };
    if ("unsupportedVersion" in loaded)
      throw new Error(
        `Unsupported routine history version ${loaded.unsupportedVersion} at ${this.path}; file left unchanged. Use a compatible plugin or explicitly restore a backup.`,
      );
    if (loaded.dropped.length > 0 && this.reported !== loaded.revision) {
      this.reported = loaded.revision;
      console.error(`paseo-bots: dropped unreadable runs from ${this.path}:\n${loaded.dropped.join("\n")}`);
    }
    loaded.sealed = safety.sealed;
    if (loaded.version !== null && loaded.version >= MANAGED_VERSION && !loaded.sealed) {
      await this.assertSource(loaded, path);
      await sealHistory(path);
      loaded.sealed = true;
    }
    return loaded;
  }

  private async parseLoaded(
    path: string,
    raw: string | null,
    safety: { known: boolean; sealed: boolean; managed: boolean },
  ): Promise<Loaded | UnsupportedVersion | null> {
    if (safety.known) {
      requireRecognizableHistory(raw, safety.sealed, safety.managed);
      try {
        return parse(raw ?? "");
      } catch (error) {
        if (error instanceof UnsupportedFileVersionError) throw error;
        throw new RunHistoryIntegrityError(`known metadata cannot be decoded: ${String(error)}`);
      }
    }
    return readParsed(path, (fresh) => {
      if (fresh !== raw) throw new UnsafeRunHistoryError("history changed while reading");
      return parse(fresh);
    });
  }

  private async assertSource(loaded: Loaded, path: string): Promise<void> {
    const raw = await readHistoryText(path);
    const revision = raw === null ? "missing" : hash(raw);
    if (revision !== loaded.revision)
      throw new RunHistoryIntegrityError(
        "history revision changed during update; no replacement was published",
      );
    if (loaded.sealed && !(await inspectHistorySeal(path)).sealed)
      throw new RunHistoryIntegrityError("initialized marker disappeared during update");
  }

  private async persist(loaded: Loaded, routines: Records, path: string): Promise<RunSnapshot> {
    const envelope = EnvelopeSchema.parse({ version: VERSION, routines, coordinator: loaded.coordinator });
    const raw = JSON.stringify(envelope, null, 2);
    await this.assertSource(loaded, path);
    await this.backup(loaded, path);
    await writeDurableAtomic(path, raw, {
      mode: 0o600,
      beforePublish: () => this.assertSource(loaded, path),
    });
    if (!loaded.sealed) await sealHistory(path);
    return { revision: hash(raw), routines: envelope.routines, coordinator: envelope.coordinator };
  }

  private async backup(loaded: Loaded, path: string): Promise<void> {
    const suffix =
      loaded.unversioned || loaded.version === 0
        ? BACKUP_SUFFIX
        : loaded.version !== VERSION
          ? `.v${loaded.version}.bak`
          : null;
    if (suffix === null) return;
    const target = `${path}${suffix}`;
    if (loaded.raw === null) throw new RunHistoryIntegrityError("migration source bytes are unavailable");
    await publishDurableExclusive(target, loaded.raw, 0o600);
    await this.assertSource(loaded, path);
  }
}
