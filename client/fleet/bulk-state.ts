import type { RpcOutput } from "@getpaseo/plugin";
import {
  type FleetApplyResult,
  type FleetChangeRequest,
  FleetChangeRequestSchema,
  type FleetPreview,
  FleetPreviewSchema,
  type FleetReceipt,
  type fleetPreviewRpc,
} from "../../shared/fleet";

export interface BulkState {
  generation: number;
  preview: FleetPreview | null;
  error: string | null;
  blocked: boolean;
  receipt: FleetReceipt | null;
}

export const INITIAL_BULK_STATE: BulkState = {
  generation: 0,
  preview: null,
  error: null,
  blocked: false,
  receipt: null,
};

export type BulkEvent =
  | { type: "edit" }
  | { type: "error"; error: string }
  | { type: "preview"; generation: number; result: RpcOutput<typeof fleetPreviewRpc> }
  | { type: "apply"; result: FleetApplyResult };

export function bulkState(state: BulkState, event: BulkEvent): BulkState {
  switch (event.type) {
    case "edit":
      return { ...INITIAL_BULK_STATE, generation: state.generation + 1 };
    case "error":
      return { ...state, error: event.error };
    case "preview":
      return receivePreview(state, event);
    case "apply":
      return event.result.status === "conflict"
        ? {
            ...state,
            blocked: true,
            error: `${event.result.error} Refresh fleet, then explicitly preview again.`,
          }
        : { ...state, receipt: event.result.receipt, preview: null, error: null, blocked: false };
  }
}

function receivePreview(state: BulkState, event: Extract<BulkEvent, { type: "preview" }>): BulkState {
  if (event.generation !== state.generation) return state;
  if (event.result.status === "conflict")
    return { ...state, preview: null, blocked: true, error: event.result.error };
  return { ...state, preview: FleetPreviewSchema.parse(event.result.preview), blocked: false, error: null };
}

/** Copies at the preview boundary; never retains a mutable form or selection array. */
export function freezeRequest(request: FleetChangeRequest): FleetChangeRequest {
  return FleetChangeRequestSchema.parse(request);
}

export function applyPreview(state: BulkState): { request: FleetChangeRequest; previewDigest: string } {
  if (!state.preview || state.blocked || state.receipt)
    throw new Error("Preview the current changes before applying.");
  if (!state.preview.compatible || state.preview.rows.some((row) => row.incompatibilities.length > 0))
    throw new Error("Incompatible targets must be resolved before applying. No bots were changed.");
  return { request: freezeRequest(state.preview.request), previewDigest: state.preview.digest };
}
