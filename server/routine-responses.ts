import type { RoutineRecord, RoutineRun, RoutineRunResponse } from "../shared/rpc";
import type { ExecutionStatus, LegacyRunStatus } from "../shared/runs";

const LEGACY_STATUS: Record<ExecutionStatus, LegacyRunStatus> = {
  queued: "running",
  reserved: "running",
  starting: "running",
  running: "running",
  waiting_for_user: "running",
  verifying: "running",
  completed: "succeeded",
  failed: "failed",
  canceled: "failed",
  unknown: "failed",
};

/**
 * Outbound only: `succeeded` historically meant a completed provider turn, never a verified task.
 * Skips retain their original labels; other canceled/unknown executions use the old failed bucket.
 * Nothing in scheduling, persistence, verification or review may consume this lossy projection.
 */
export function routineRunResponse(run: RoutineRun): RoutineRunResponse {
  const status = run.skipped ? (`skipped-${run.skipped}` as const) : LEGACY_STATUS[run.executionStatus];
  return { ...run, status };
}

/** Preserve the old status envelope and every old run field, adding the authoritative facts alongside. */
export function routineStatusResponse(snapshot: {
  scheduler: boolean;
  routines: Record<string, RoutineRecord>;
}) {
  return {
    scheduler: snapshot.scheduler,
    routines: Object.fromEntries(
      Object.entries(snapshot.routines).map(([id, record]) => [
        id,
        { ...record, runs: record.runs.map(routineRunResponse) },
      ]),
    ),
  };
}
