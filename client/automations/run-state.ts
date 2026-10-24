import type { RpcInput } from "@getpaseo/plugin";
import type { runsListRpc } from "../../shared/rpc";
import type { ExecutionStatus } from "../../shared/runs";

export interface RunFiltersValue {
  botId: string;
  routineId: string;
  executionStatus: ExecutionStatus | "";
}

export interface RunPages {
  filters: RunFiltersValue;
  cursors: (string | undefined)[];
}

export const INITIAL_RUN_PAGES: RunPages = {
  filters: { botId: "", routineId: "", executionStatus: "" },
  cursors: [undefined],
};

export type RunPageEvent =
  | { type: "filter"; filters: RunFiltersValue }
  | { type: "next"; cursor: string | null }
  | { type: "previous" }
  | { type: "reload" };

export function runPages(state: RunPages, event: RunPageEvent): RunPages {
  switch (event.type) {
    case "filter":
      return {
        filters: {
          ...event.filters,
          routineId: event.filters.botId === state.filters.botId ? event.filters.routineId : "",
        },
        cursors: [undefined],
      };
    case "next":
      return event.cursor === null ? state : { ...state, cursors: [...state.cursors, event.cursor] };
    case "previous":
      return state.cursors.length > 1 ? { ...state, cursors: state.cursors.slice(0, -1) } : state;
    case "reload":
      return { ...state, cursors: [undefined] };
  }
}

export function runListInput(state: RunPages): RpcInput<typeof runsListRpc> {
  const { botId, routineId, executionStatus } = state.filters;
  return {
    limit: 25,
    cursor: state.cursors[state.cursors.length - 1],
    ...(botId ? { botId } : {}),
    ...(routineId ? { routineId } : {}),
    ...(executionStatus ? { executionStatus } : {}),
  };
}

export interface AutomationsView {
  runId: string | null;
}

export const backFromAutomations = (view: AutomationsView): AutomationsView | null =>
  view.runId === null ? null : { runId: null };
