import { z } from "zod";
import type { RoutineRun } from "../shared/rpc";
import type { RunSnapshot } from "./run-store";

export interface RunHistoryFilter {
  cursor?: string;
  limit?: number;
  botId?: string;
  routineId?: string;
  executionStatus?: RoutineRun["executionStatus"];
}

export interface RunHistoryPage {
  runs: RoutineRun[];
  nextCursor: string | null;
}

type HistoryKey = [startedAt: string, runId: string, recordId: string];
interface HistoryEntry {
  key: HistoryKey;
  run: RoutineRun;
  botId: string | undefined;
  routineId: string | null;
}

const CursorSchema = z.object({ version: z.literal(1), key: z.tuple([z.string(), z.string(), z.string()]) });

function compareKeys(left: HistoryKey, right: HistoryKey): number {
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a !== b) return a > b ? -1 : 1;
  }
  return 0;
}

function decodeCursor(cursor: string): HistoryKey {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Invalid encoding");
    const bytes = Buffer.from(cursor, "base64url");
    if (bytes.toString("base64url") !== cursor) throw new Error("Invalid encoding");
    return CursorSchema.parse(JSON.parse(bytes.toString("utf8"))).key;
  } catch {
    throw new Error("Invalid run history cursor");
  }
}

function matches(entry: HistoryEntry, filter: RunHistoryFilter): boolean {
  if (filter.botId !== undefined && entry.botId !== filter.botId) return false;
  if (filter.routineId !== undefined && entry.routineId !== filter.routineId) return false;
  return filter.executionStatus === undefined || entry.run.executionStatus === filter.executionStatus;
}

function receiptBots(snapshot: RunSnapshot): Map<string, string | null> {
  const bots = new Map<string, string | null>();
  for (const receipt of Object.values(snapshot.coordinator.requests)) {
    const key = JSON.stringify([receipt.recordId, receipt.runId]);
    const prior = bots.get(key);
    bots.set(key, prior === undefined || prior === receipt.botId ? receipt.botId : null);
  }
  return bots;
}

/** Disposable ordering and lookup state; the authoritative snapshot is its only input. */
export class RunHistoryIndex {
  private revision: string | null = null;
  private entries: HistoryEntry[] = [];
  private readonly byId = new Map<string, RoutineRun | null>();

  rebuild(snapshot: RunSnapshot): void {
    this.byId.clear();
    const legacyBots = receiptBots(snapshot);
    this.entries = Object.entries(snapshot.routines).flatMap(([recordId, record]) =>
      record.runs.map((run): HistoryEntry => {
        this.byId.set(run.id, this.byId.has(run.id) ? null : run);
        return {
          key: [run.startedAt, run.id, recordId],
          run,
          botId: run.managed?.botId ?? legacyBots.get(JSON.stringify([recordId, run.id])) ?? undefined,
          routineId: run.managed ? run.managed.routineId : recordId,
        };
      }),
    );
    this.entries.sort((left, right) => compareKeys(left.key, right.key));
    this.revision = snapshot.revision;
  }

  get(snapshot: RunSnapshot, runId: string): RoutineRun | null {
    if (this.revision !== snapshot.revision) this.rebuild(snapshot);
    const run = this.byId.get(runId);
    if (run === null) throw new Error(`Run identity ${runId} is ambiguous across historical records`);
    return run === undefined ? null : structuredClone(run);
  }

  list(snapshot: RunSnapshot, filter: RunHistoryFilter): RunHistoryPage {
    if (this.revision !== snapshot.revision) this.rebuild(snapshot);
    const after = filter.cursor === undefined ? null : decodeCursor(filter.cursor);
    const requested = filter.limit ?? 30;
    if (!Number.isFinite(requested)) throw new Error("Invalid run history page limit");
    const limit = Math.min(100, Math.max(1, Math.floor(requested)));
    const page = this.select(filter, after, limit);
    const more = page.length > limit;
    if (more) page.pop();
    const last = page[page.length - 1];
    return {
      runs: structuredClone(page.map((entry) => entry.run)),
      nextCursor: more
        ? Buffer.from(JSON.stringify({ version: 1, key: last?.key })).toString("base64url")
        : null,
    };
  }

  private select(filter: RunHistoryFilter, after: HistoryKey | null, limit: number): HistoryEntry[] {
    const page: HistoryEntry[] = [];
    for (const entry of this.entries) {
      if (after && compareKeys(entry.key, after) <= 0) continue;
      if (!matches(entry, filter)) continue;
      page.push(entry);
      if (page.length > limit) break;
    }
    return page;
  }
}
