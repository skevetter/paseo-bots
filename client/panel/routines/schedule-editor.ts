import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { Routine } from "../../../shared/bot";
import { newSchedulePolicy, SchedulePolicySchema } from "../../../shared/schedule-policy";
import { routinePreviewScheduleRpc } from "../../../shared/schedule-preview";

export type PreviewInput = RpcInput<typeof routinePreviewScheduleRpc>;
export type PreviewResult = RpcOutput<typeof routinePreviewScheduleRpc>;
export type PolicyDraft = NonNullable<Routine["schedulePolicy"]>;

export function initialSchedulePolicy(routine: Routine | null): PolicyDraft | undefined {
  return routine ? routine.schedulePolicy : newSchedulePolicy();
}

export function schedulePolicyError(policy: unknown): string | null {
  const parsed = SchedulePolicySchema.optional().safeParse(policy);
  return parsed.success ? null : parsed.error.issues[0].message;
}

export function applyRoutineDraft(
  base: Routine,
  draft: Pick<Routine, "name" | "prompt" | "schedule" | "resultsChatId" | "schedulePolicy">,
): Routine {
  const policy = SchedulePolicySchema.optional().parse(draft.schedulePolicy);
  const { schedulePolicy: _policy, ...fields } = draft;
  return { ...base, ...fields, ...(policy ? { schedulePolicy: policy } : {}) };
}

export function previewInput(draft: PreviewInput): PreviewInput {
  // Parsing snapshots nested fields so later edits cannot mutate an in-flight request.
  return routinePreviewScheduleRpc.input.parse(draft);
}

export interface PreviewState {
  token: number;
  pending: boolean;
  result: PreviewResult | null;
  error: string | null;
}

export type PreviewAction =
  | { type: "invalidate"; token: number }
  | { type: "start"; token: number }
  | { type: "result"; token: number; result: PreviewResult }
  | { type: "error"; token: number; error: string };

export const emptyPreview: PreviewState = { token: 0, pending: false, result: null, error: null };

export function reducePreview(state: PreviewState, action: PreviewAction): PreviewState {
  if (action.type === "invalidate" || action.type === "start") {
    return { token: action.token, pending: action.type === "start", result: null, error: null };
  }
  if (action.token !== state.token) return state;
  if (action.type === "result") return { ...state, pending: false, result: action.result };
  return { ...state, pending: false, error: action.error };
}
