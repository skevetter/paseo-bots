import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import {
  chatsStartRpc,
  type LocalChatInput,
  type LocalChatStartResult,
  LocalChatStartResultSchema,
} from "../../shared/local-start";
import { type RoutineRun, RoutineRunSchema, runsCancelRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { ui } from "../typography";
import { useMountedRef } from "./composer/mounted";

type Colors = PluginTheme["colors"];

export interface UnconfirmedStart {
  input: LocalChatInput;
  result: LocalChatStartResult;
}

export interface ChatStartFeedback {
  pending: UnconfirmedStart[];
  report(input: LocalChatInput, result: LocalChatStartResult): void;
  dismiss(input: LocalChatInput): void;
}

export function useChatStartFeedback(): ChatStartFeedback {
  const [pending, setPending] = useState<UnconfirmedStart[]>([]);
  const mounted = useMountedRef();
  return {
    pending,
    report: (input, result) => {
      if (!mounted.current) return;
      setPending((current) => {
        const same = (entry: UnconfirmedStart) =>
          entry.input.botId === input.botId && entry.input.requestId === input.requestId;
        const next = { input, result };
        return current.some(same) ? current.map((entry) => (same(entry) ? next : entry)) : [...current, next];
      });
    },
    dismiss: (input) =>
      setPending((current) =>
        current.filter(
          (entry) => entry.input.botId !== input.botId || entry.input.requestId !== input.requestId,
        ),
      ),
  };
}

interface NoticeProps {
  colors: Colors;
  value: UnconfirmedStart;
  onResult(result: LocalChatStartResult): void;
  onCreated(agentId: string): void;
  onClose(): void;
}

function canceledBeforeCreate(run: RoutineRun): boolean {
  return run.executionStatus === "canceled" && run.agentCreationStatus === "not_created";
}

function useNoticeActions({ value, onResult, onCreated }: NoticeProps) {
  const check = useRpc(chatsStartRpc);
  const cancel = useRpc(runsCancelRpc);
  const mounted = useMountedRef();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const perform = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (mounted.current) setError(errorText(failure));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return {
    busy,
    error,
    check: () =>
      void perform(async () => {
        const result = LocalChatStartResultSchema.parse(await check(value.input));
        if (!mounted.current) return;
        onResult(result);
        if (result.status === "created" && result.agentId) onCreated(result.agentId);
      }),
    cancel: () => {
      const planId = value.result.planId;
      if (!planId) return;
      void perform(async () => {
        const response = await cancel({ runId: planId });
        if (!mounted.current) return;
        const run = RoutineRunSchema.parse(response.run);
        if (canceledBeforeCreate(run))
          onResult({
            ...value.result,
            status: "not_created",
            agentId: null,
            run: {
              id: run.id,
              executionStatus: run.executionStatus,
              agentCreationStatus: run.agentCreationStatus ?? "unknown",
              taskOutcome: run.taskOutcome,
              purpose: run.purpose,
            },
            message: "Canceled before launch. No agent was created.",
          });
        else setError(response.error ?? "Cancellation requested; work has not been proven stopped.");
      });
    },
  };
}

export function LocalStartNotice(props: NoticeProps) {
  const { colors, value, onClose } = props;
  const { result, input } = value;
  const actions = useNoticeActions(props);
  return (
    <View style={{ padding: 16, gap: 8, borderBottomWidth: 1, borderColor: colors.border }}>
      <Text
        accessibilityRole="alert"
        style={{ color: colors.foreground, fontSize: ui(14), fontWeight: "600" }}
      >
        {result.status === "not_created" ? "No agent created" : "Creation not yet confirmed"}
      </Text>
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
        {result.message ?? "The request is retained. A planned identity is not proof that its agent exists."}
      </Text>
      {result.run ? (
        <Text selectable style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
          {result.run.id} · {result.run.executionStatus} / {result.run.taskOutcome}
        </Text>
      ) : null}
      <Text selectable numberOfLines={3} style={{ color: colors.foreground, fontSize: ui(12) }}>
        {input.prompt}
      </Text>
      <Text style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
        {input.images.length + input.attachments.length} attachments retained for checking this exact request.
        Closing this notice does not cancel work.
      </Text>
      {actions.error ? (
        <Text accessibilityRole="alert" style={{ color: colors.statusDanger, fontSize: ui(12) }}>
          {actions.error}
        </Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {result.status === "pending" ? (
          <Button
            colors={colors}
            label="Check existing request"
            loading={actions.busy}
            onPress={actions.check}
          />
        ) : null}
        {result.status === "pending" && result.mode === "managed" ? (
          <Button
            colors={colors}
            label="Request cancellation"
            disabled={actions.busy}
            onPress={actions.cancel}
          />
        ) : null}
        <Button colors={colors} label="Dismiss notice" disabled={actions.busy} onPress={onClose} />
      </View>
    </View>
  );
}
