import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import {
  type AutomationApplyResult,
  type AutomationChangeRequest,
  AutomationChangeRequestSchema,
  type AutomationPreview,
  AutomationPreviewSchema,
  type AutomationReceipt,
  type AutomationsFilter,
  AutomationsFilterSchema,
  type automationsPreviewRpc,
  type automationsRevertRpc,
  type automationsRunNowRpc,
  MAX_AUTOMATION_TARGETS,
} from "../../shared/automations";

export const AUTOMATIONS_KEY = ["paseo-bots", "automations"] as const;
export interface CatalogPages {
  filters: AutomationsFilter;
  cursors: (string | undefined)[];
}
export const INITIAL_CATALOG_PAGES: CatalogPages = { filters: {}, cursors: [undefined] };
export type CatalogPageEvent =
  | { type: "filter"; filters: AutomationsFilter }
  | { type: "next"; cursor: string | null }
  | { type: "previous" }
  | { type: "reload" };
export function catalogPages(state: CatalogPages, event: CatalogPageEvent): CatalogPages {
  switch (event.type) {
    case "filter":
      return { filters: AutomationsFilterSchema.parse(event.filters), cursors: [undefined] };
    case "next":
      return event.cursor === null ? state : { ...state, cursors: [...state.cursors, event.cursor] };
    case "previous":
      return state.cursors.length === 1 ? state : { ...state, cursors: state.cursors.slice(0, -1) };
    case "reload":
      return { ...state, cursors: [undefined] };
  }
}
export function catalogListInput(state: CatalogPages) {
  return { ...state.filters, cursor: state.cursors[state.cursors.length - 1], limit: 100 };
}
export function selectCatalogIds(selected: readonly string[], ids: readonly string[]): string[] {
  const next = [...new Set([...selected, ...ids])];
  if (next.length > MAX_AUTOMATION_TARGETS)
    throw new Error(`Select at most ${MAX_AUTOMATION_TARGETS} routines. Selection was not changed.`);
  return next;
}

export function freezeCatalogRequest(input: AutomationChangeRequest): AutomationChangeRequest {
  const request = AutomationChangeRequestSchema.parse(input);
  Object.freeze(request.targetIds);
  return Object.freeze(request);
}
function sameRequest(a: AutomationChangeRequest, b: AutomationChangeRequest): boolean {
  return (
    a.operationId === b.operationId &&
    a.revision === b.revision &&
    a.enabled === b.enabled &&
    a.targetIds.length === b.targetIds.length &&
    a.targetIds.every((id, index) => id === b.targetIds[index])
  );
}
export interface CatalogChangeState {
  generation: number;
  request: AutomationChangeRequest | null;
  preview: AutomationPreview | null;
  receipt: AutomationReceipt | null;
  phase: "idle" | "previewing" | "review" | "applying" | "uncertain" | "conflict" | "applied";
  error: string | null;
  needsRefresh: boolean;
}
export const INITIAL_CATALOG_CHANGE: CatalogChangeState = {
  generation: 0,
  request: null,
  preview: null,
  receipt: null,
  phase: "idle",
  error: null,
  needsRefresh: false,
};
export type CatalogChangeEvent =
  | { type: "begin"; request: AutomationChangeRequest }
  | { type: "preview"; generation: number; result: RpcOutput<typeof automationsPreviewRpc> }
  | { type: "preview-error"; generation: number; error: string }
  | { type: "applying" }
  | { type: "apply"; result: AutomationApplyResult }
  | { type: "apply-error"; error: string }
  | { type: "refreshed" }
  | { type: "require-refresh" }
  | { type: "close" };
const CONFLICT_HELP =
  "Refresh catalog, then start a new explicit preview. Nothing is automatically re-previewed or applied.";
export function catalogChange(state: CatalogChangeState, event: CatalogChangeEvent): CatalogChangeState {
  const locked = state.phase === "applying" || state.phase === "uncertain";
  switch (event.type) {
    case "begin":
      if (locked || state.needsRefresh) return state;
      return {
        ...INITIAL_CATALOG_CHANGE,
        generation: state.generation + 1,
        request: freezeCatalogRequest(event.request),
        phase: "previewing",
      };
    case "close":
      return locked
        ? state
        : { ...INITIAL_CATALOG_CHANGE, needsRefresh: state.needsRefresh, generation: state.generation + 1 };
    case "refreshed":
      return { ...state, needsRefresh: false };
    case "require-refresh":
      return { ...state, needsRefresh: true };
    case "preview-error":
      return receivePreviewError(state, event);
    case "preview":
      return receiveCatalogPreview(state, event);
    case "applying":
      catalogApplyBody(state);
      return { ...state, phase: "applying", error: null };
    case "apply-error":
      return {
        ...state,
        phase: "uncertain",
        error: `${event.error} Outcome unknown. Retry this exact operation to recover its receipt.`,
      };
    case "apply":
      return event.result.status === "conflict"
        ? { ...state, phase: "conflict", needsRefresh: true, error: `${event.result.error} ${CONFLICT_HELP}` }
        : { ...state, phase: "applied", receipt: event.result.receipt, error: null };
  }
}
function receivePreviewError(
  state: CatalogChangeState,
  event: Extract<CatalogChangeEvent, { type: "preview-error" }>,
): CatalogChangeState {
  const relevant = event.generation === state.generation && state.phase === "previewing";
  return relevant
    ? { ...state, phase: "conflict", needsRefresh: true, error: `${event.error} ${CONFLICT_HELP}` }
    : state;
}
function receiveCatalogPreview(
  state: CatalogChangeState,
  event: Extract<CatalogChangeEvent, { type: "preview" }>,
): CatalogChangeState {
  if (event.generation !== state.generation || state.phase !== "previewing" || !state.request) return state;
  if (event.result.status === "conflict")
    return {
      ...state,
      phase: "conflict",
      needsRefresh: true,
      error: `${event.result.error} ${CONFLICT_HELP}`,
    };
  const preview = AutomationPreviewSchema.parse(event.result.preview);
  const targetIds = state.request.targetIds;
  const exactRows =
    preview.rows.length === targetIds.length &&
    preview.rows.every(
      (row, index) => row.id === targetIds[index] && row.afterEnabled === state.request?.enabled,
    );
  if (!sameRequest(state.request, preview.request) || !exactRows)
    return {
      ...state,
      phase: "conflict",
      needsRefresh: true,
      error: `Preview did not match the frozen request. ${CONFLICT_HELP}`,
    };
  return { ...state, preview, phase: "review", error: null };
}
export function catalogApplyBody(state: CatalogChangeState) {
  if (!state.request || !state.preview || (state.phase !== "review" && state.phase !== "uncertain"))
    throw new Error("Preview these exact changes before applying.");
  if (!state.preview.compatible || state.preview.rows.some((row) => row.incompatibilities.length > 0))
    throw new Error("Resolve all incompatible targets before applying. No routines were changed.");
  return { request: state.request, previewDigest: state.preview.digest };
}

export type CatalogRevertRequest = RpcInput<typeof automationsRevertRpc>;
export interface CatalogRevertState {
  request: CatalogRevertRequest | null;
  phase: "idle" | "pending" | "uncertain" | "conflict" | "done";
  receipt: AutomationReceipt | null;
  error: string | null;
}
export const INITIAL_CATALOG_REVERT: CatalogRevertState = {
  request: null,
  phase: "idle",
  receipt: null,
  error: null,
};
export function catalogRevertRequest(
  state: CatalogRevertState,
  input: CatalogRevertRequest,
): CatalogRevertRequest {
  if (state.phase === "uncertain" || state.phase === "pending") {
    if (!state.request) throw new Error("Missing revert request.");
    return state.request;
  }
  return Object.freeze({ ...input });
}
export type CatalogRunRequest = RpcInput<typeof automationsRunNowRpc>;
export interface CatalogRunState {
  request: CatalogRunRequest;
  phase: "pending" | "uncertain" | "done";
  runId: string | null;
  error: string | null;
}
export function catalogRunRequest(
  state: CatalogRunState | undefined,
  input: CatalogRunRequest,
  newWorkload = false,
): CatalogRunRequest {
  if (!state) return Object.freeze({ ...input });
  if (state.request.botId !== input.botId || state.request.routineId !== input.routineId)
    throw new Error("Run identity belongs to a different routine.");
  if (state.phase !== "done") return state.request;
  if (!newWorkload) throw new Error("This workload already has a run. Choose New run explicitly.");
  if (state.request.requestId === input.requestId)
    throw new Error("A new workload requires a new request identity.");
  return Object.freeze({ ...input });
}
