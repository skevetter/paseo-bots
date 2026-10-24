import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import {
  chatsStartRpc,
  type LocalChatInput,
  type LocalChatStartResult,
  LocalChatStartResultSchema,
} from "../../shared/local-start";
import { type RoutineRun, RoutineRunSchema, runsCancelRpc } from "../../shared/rpc";
import type { BotHost } from "../data";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { ui } from "../typography";
import { useMountedRef } from "./composer/mounted";
import { flushLocalStartSettings } from "./localStartSettings";

type Colors = PluginTheme["colors"];
export type StartOrigin = Pick<BotHost, "key" | "label" | "isLocal">;

export function matchesStartOrigin(origin: StartOrigin, host: StartOrigin): boolean {
  return origin.key === host.key && origin.isLocal === host.isLocal;
}

export interface UnconfirmedStart {
  origin: StartOrigin;
  input: LocalChatInput;
  result: LocalChatStartResult | null;
}

export interface CreatedStart {
  origin: StartOrigin;
  botId: string;
  requestId: string;
  agentId: string;
}

export interface ChatStartFeedback {
  pending: UnconfirmedStart[];
  created: CreatedStart[];
  find(origin: StartOrigin, input: LocalChatInput): UnconfirmedStart | undefined;
  report(origin: StartOrigin, input: LocalChatInput, result: LocalChatStartResult | null): void;
  dismiss(origin: StartOrigin, input: LocalChatInput): void;
  reportCreated(value: CreatedStart): void;
  dismissCreated(value: CreatedStart): void;
}

export function useChatStartFeedback(): ChatStartFeedback {
  const [pending, setPending] = useState<UnconfirmedStart[]>([]);
  const [created, setCreated] = useState<CreatedStart[]>([]);
  const latest = useRef(pending);
  const mounted = useMountedRef();
  return {
    pending,
    created,
    find: (origin, input) =>
      latest.current.find(
        (entry) =>
          matchesStartOrigin(entry.origin, origin) && JSON.stringify(entry.input) === JSON.stringify(input),
      ),
    report: (origin, input, result) => {
      if (!mounted.current) return;
      const same = (entry: UnconfirmedStart) =>
        matchesStartOrigin(entry.origin, origin) &&
        entry.input.botId === input.botId &&
        entry.input.requestId === input.requestId;
      const next = { origin, input, result };
      latest.current = latest.current.some(same)
        ? latest.current.map((entry) => (same(entry) ? next : entry))
        : [...latest.current, next];
      setPending(latest.current);
    },
    dismiss: (origin, input) => {
      latest.current = latest.current.filter(
        (entry) =>
          !matchesStartOrigin(entry.origin, origin) ||
          entry.input.botId !== input.botId ||
          entry.input.requestId !== input.requestId,
      );
      if (mounted.current) setPending(latest.current);
    },
    reportCreated: (value) => {
      if (!mounted.current) return;
      setCreated((current) => [
        ...current.filter(
          (entry) =>
            !matchesStartOrigin(entry.origin, value.origin) ||
            entry.botId !== value.botId ||
            entry.requestId !== value.requestId,
        ),
        value,
      ]);
    },
    dismissCreated: (value) => setCreated((current) => current.filter((entry) => entry !== value)),
  };
}

interface NoticeProps {
  colors: Colors;
  value: UnconfirmedStart;
  canAct: boolean;
  beforeCheck(): Promise<void>;
  onResult(result: LocalChatStartResult): void;
  onCreated(agentId: string): void;
  onClose(): void;
}

function canceledBeforeCreate(run: RoutineRun): boolean {
  return run.executionStatus === "canceled" && run.agentCreationStatus === "not_created";
}

function useNoticeActions({ value, canAct, beforeCheck, onResult, onCreated }: NoticeProps) {
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
        if (!canAct) return;
        await beforeCheck();
        const result = LocalChatStartResultSchema.parse(await check(value.input));
        onResult(result);
        if (result.status === "created" && result.agentId) onCreated(result.agentId);
      }),
    cancel: () => {
      if (!canAct) return;
      const planId = value.result?.planId;
      if (!planId) return;
      void perform(async () => {
        const response = await cancel({ runId: planId });
        const run = RoutineRunSchema.parse(response.run);
        if (canceledBeforeCreate(run))
          onResult({
            ...value.result,
            mode: "managed",
            planId,
            plannedAgentId: value.result?.plannedAgentId ?? null,
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
        else if (mounted.current)
          setError(response.error ?? "Cancellation requested; work has not been proven stopped.");
      });
    },
  };
}

function OriginDetails({
  colors,
  origin,
  requestId,
  agentId,
  canAct,
}: {
  colors: Colors;
  origin: StartOrigin;
  requestId: string;
  agentId: string | null;
  canAct: boolean;
}) {
  return (
    <Text selectable style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
      Host: {origin.label} ({origin.key}). Request: {requestId}.{agentId ? ` Agent: ${agentId}.` : ""}
      {!canAct
        ? " Select this bot's origin host to recover or open this result. No action is sent to the current host."
        : ""}
    </Text>
  );
}

function CreatedStartNotice({
  colors,
  value,
  canOpen,
  onOpen,
  onClose,
}: {
  colors: Colors;
  value: CreatedStart;
  canOpen: boolean;
  onOpen(): void;
  onClose(): void;
}) {
  return (
    <View style={{ padding: 16, gap: 8, borderBottomWidth: 1, borderColor: colors.border }}>
      <Text accessibilityRole="alert" style={{ color: colors.foreground, fontSize: ui(14) }}>
        Agent created on origin host
      </Text>
      <OriginDetails
        colors={colors}
        origin={value.origin}
        requestId={value.requestId}
        agentId={value.agentId}
        canAct={canOpen}
      />
      <Button colors={colors} label="Open created chat" disabled={!canOpen} onPress={onOpen} />
      <Button colors={colors} label="Dismiss notice" onPress={onClose} />
    </View>
  );
}

const START_TITLES: Record<LocalChatStartResult["status"], string> = {
  created: "Agent created on origin host",
  not_created: "No agent created",
  pending: "Creation not yet confirmed",
};

interface NoticeActions {
  busy: boolean;
  error: string | null;
  check(): void;
  cancel(): void;
}

function LocalStartButtons({ props, actions }: { props: NoticeProps; actions: NoticeActions }) {
  const { colors, value, canAct, onClose, onCreated } = props;
  const { result } = value;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {!result || result.status === "pending" ? (
        <Button
          colors={colors}
          label="Check existing request"
          loading={actions.busy}
          disabled={!canAct}
          onPress={actions.check}
        />
      ) : null}
      {result?.status === "created" && result.agentId ? (
        <Button
          colors={colors}
          label="Open created chat"
          disabled={!canAct}
          onPress={() => {
            if (result.agentId) onCreated(result.agentId);
          }}
        />
      ) : null}
      {result?.status === "pending" && result.mode === "managed" ? (
        <Button
          colors={colors}
          label="Request cancellation"
          disabled={!canAct || actions.busy}
          onPress={actions.cancel}
        />
      ) : null}
      <Button colors={colors} label="Dismiss notice" disabled={actions.busy} onPress={onClose} />
    </View>
  );
}

export function LocalStartNotice(props: NoticeProps) {
  const { colors, value, canAct } = props;
  const { result, input } = value;
  const actions = useNoticeActions(props);
  return (
    <View style={{ padding: 16, gap: 8, borderBottomWidth: 1, borderColor: colors.border }}>
      <Text
        accessibilityRole="alert"
        style={{ color: colors.foreground, fontSize: ui(14), fontWeight: "600" }}
      >
        {START_TITLES[result?.status ?? "pending"]}
      </Text>
      <OriginDetails
        colors={colors}
        origin={value.origin}
        requestId={input.requestId}
        agentId={result?.agentId ?? result?.plannedAgentId ?? null}
        canAct={canAct}
      />
      <Text selectable style={{ color: colors.foregroundMuted, fontSize: ui(12) }}>
        {result?.message ?? "The request is retained. A planned identity is not proof that its agent exists."}
      </Text>
      {result?.run ? (
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
      <LocalStartButtons props={props} actions={actions} />
    </View>
  );
}

export function ChatStartNotices({
  colors,
  botId,
  host,
  compact,
  feedback,
  onStarted,
  flush,
  hasDraft,
}: {
  colors: Colors;
  botId: string;
  host: BotHost;
  compact: boolean;
  feedback: ChatStartFeedback;
  onStarted(agentId: string): void;
  flush(): Promise<boolean>;
  hasDraft(botId: string): boolean;
}) {
  const mounted = useMountedRef();
  const latest = useRef({ host, botId, onStarted, flush, hasDraft });
  latest.current = { host, botId, onStarted, flush, hasDraft };
  const isCurrent = (origin: StartOrigin) =>
    mounted.current &&
    latest.current.botId === botId &&
    matchesStartOrigin(origin, latest.current.host) &&
    latest.current.host.api !== null;
  const open = (origin: StartOrigin, agentId: string) => {
    if (!isCurrent(origin)) return false;
    latest.current.onStarted(agentId);
    return true;
  };
  const beforeCheck = async (entry: UnconfirmedStart) => {
    const current = () => isCurrent(entry.origin);
    if (!current()) throw new Error("Select the origin host before checking this request.");
    if (!entry.result) await flushLocalStartSettings(latest.current, botId, current);
    if (!current()) throw new Error("The bot host changed while saving. Retry on the origin host.");
  };
  return (
    <ScrollView style={{ maxHeight: compact ? 220 : 280, flexGrow: 0 }}>
      {feedback.pending
        .filter((entry) => entry.input.botId === botId)
        .map((entry) => (
          <LocalStartNotice
            key={`${entry.origin.key}:${entry.input.requestId}`}
            colors={colors}
            value={entry}
            canAct={matchesStartOrigin(entry.origin, host) && host.api !== null}
            beforeCheck={() => beforeCheck(entry)}
            onResult={(result) => feedback.report(entry.origin, entry.input, result)}
            onCreated={(id) => {
              if (open(entry.origin, id)) feedback.dismiss(entry.origin, entry.input);
            }}
            onClose={() => feedback.dismiss(entry.origin, entry.input)}
          />
        ))}
      {feedback.created
        .filter((entry) => entry.botId === botId)
        .map((entry) => (
          <CreatedStartNotice
            key={`${entry.origin.key}:${entry.requestId}`}
            colors={colors}
            value={entry}
            canOpen={matchesStartOrigin(entry.origin, host) && host.api !== null}
            onOpen={() => {
              if (open(entry.origin, entry.agentId)) feedback.dismissCreated(entry);
            }}
            onClose={() => feedback.dismissCreated(entry)}
          />
        ))}
    </ScrollView>
  );
}
