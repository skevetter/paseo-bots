import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useReducer, useRef, useState } from "react";
import type { Routine } from "../../../shared/bot";
import { newSchedulePolicy } from "../../../shared/schedule-policy";
import { routinePreviewScheduleRpc } from "../../../shared/schedule-preview";
import { errorText } from "../../native";
import {
  emptyPreview,
  initialSchedulePolicy,
  type PolicyDraft,
  type PreviewState,
  previewInput,
  reducePreview,
  schedulePolicyError,
} from "./schedule-editor";

export interface ScheduleEditor {
  policy: PolicyDraft | undefined;
  policyError: string | null;
  after: string;
  afterError: string | null;
  preview: PreviewState;
  invalidate(): void;
  changePolicy(next: PolicyDraft): void;
  adopt(): void;
  changeAfter(next: string): void;
  loadPreview(draft: { schedule: Routine["schedule"]; since: string }): Promise<void>;
}

export function useScheduleEditor(routine: Routine | null): ScheduleEditor {
  const [policy, setPolicy] = useState(() => initialSchedulePolicy(routine));
  const [after, setAfter] = useState(() => new Date().toISOString());
  const [preview, dispatch] = useReducer(reducePreview, emptyPreview);
  const token = useRef(0);
  const rpc = useRpc(routinePreviewScheduleRpc);
  const mutation = useMutation({ mutationFn: rpc, retry: false });
  const invalidate = () => dispatch({ type: "invalidate", token: ++token.current });
  const changePolicy = (next: PolicyDraft) => {
    invalidate();
    setPolicy(next);
  };
  const changeAfter = (next: string) => {
    invalidate();
    setAfter(next);
  };
  const loadPreview = async (draft: { schedule: Routine["schedule"]; since: string }) => {
    const request = ++token.current;
    dispatch({ type: "start", token: request });
    try {
      const input = previewInput({ ...draft, schedulePolicy: policy, after, count: 5 });
      const result = await mutation.mutateAsync(input);
      dispatch({ type: "result", token: request, result });
    } catch (error) {
      dispatch({ type: "error", token: request, error: errorText(error) });
    }
  };
  return {
    policy,
    policyError: schedulePolicyError(policy),
    after,
    afterError: routinePreviewScheduleRpc.input.shape.after.safeParse(after).success
      ? null
      : "Use an ISO UTC date, for example 2026-11-01T05:00:00Z.",
    preview,
    invalidate,
    changePolicy,
    adopt: () => changePolicy(newSchedulePolicy()),
    changeAfter,
    loadPreview,
  };
}
