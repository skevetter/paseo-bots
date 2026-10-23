import { createHash } from "node:crypto";
import type { RoutineRun } from "../shared/rpc";
import { OccurrenceKeySchema, occurrenceKeyOf, type Trigger } from "../shared/runs";
import type { RunSnapshot } from "./run-store";

export interface ReplayRequest {
  botId?: string;
  routineId?: string;
  trigger: Trigger;
  requestId: string;
  requestHash: string;
  due?: Date;
}
export interface LegacyAdmission extends ReplayRequest {
  botId: string;
  routineId: string;
  due: Date;
}
export class RequestConflictError extends Error {
  readonly code = "request_conflict";
  constructor() {
    super("This request identity already exists with a different or unavailable original body digest.");
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}
export function requestHashOf(value: unknown): string {
  const text = JSON.stringify(canonical(value));
  if (text === undefined) throw new Error("Request body is not JSON serializable.");
  return createHash("sha256").update(text).digest("hex");
}
export function requestKey(input: Omit<ReplayRequest, "requestHash">) {
  if (!input.routineId && !input.botId) throw new Error("Request identity requires a bot or routine ID.");
  const recordId = input.routineId ?? `chat:${input.botId}`;
  if (input.trigger === "schedule") {
    if (!input.due) throw new Error("Scheduled replay requires its original due instant.");
    return occurrenceKeyOf(recordId, input.trigger, input.due.toISOString(), input.requestId);
  }
  return OccurrenceKeySchema.parse(
    `request:${createHash("sha256")
      .update(JSON.stringify([recordId, input.trigger, input.requestId]))
      .digest("hex")}`,
  );
}
export function existingRequest(state: RunSnapshot, key: string, digest: string): RoutineRun | null {
  const receipt = state.coordinator.requests[key];
  const id = receipt?.runId ?? state.coordinator.occurrences[key];
  if (!id) return null;
  const record = Object.values(state.routines)
    .flatMap((entry) => entry.runs)
    .find((run) => run.id === id);
  const savedHash = receipt?.requestHash ?? record?.managed?.requestHash;
  if (!savedHash || savedHash !== digest) throw new RequestConflictError();
  if (!record)
    throw new Error(`The admitted request ${id} has unavailable authoritative metadata; replay is refused.`);
  return record;
}
export function rememberRequest(state: RunSnapshot, input: ReplayRequest, run: RoutineRun): void {
  const key = requestKey(input);
  state.coordinator.occurrences[key] = run.id;
  const botId = input.botId ?? run.managed?.botId;
  if (!botId) throw new Error("New request receipt requires its admitted bot identity.");
  state.coordinator.requests[key] = {
    runId: run.id,
    recordId: input.routineId ?? `chat:${botId}`,
    botId,
    requestHash: input.requestHash,
    mode: run.managed ? "managed" : "legacy",
  };
}
