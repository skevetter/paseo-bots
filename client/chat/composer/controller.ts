import type { PluginTheme } from "@getpaseo/plugin";
import { useEffect, useRef } from "react";
import { type TextInput as NativeTextInput, Platform, useWindowDimensions, type View } from "react-native";
import type { Bot } from "../../../shared/bot";
import type { ChatPaneProps, OutgoingMessage } from "../../ChatPane";
import type { BotHost } from "../../data";
import type { PaseoAgent } from "../../paseo";
import { content } from "../../typography";
import { domNode, focusWithRetries } from "../../web";
import { useAttachmentSources, useFileAttachments, usePasteSheet } from "./attachments";
import { useSlashCommands } from "./commands";
import { useComposerDraft } from "./draftState";
import { useQueue } from "./drafts";
import { conversationKind, conversationNotice, startsNewTask } from "./execution";
import { useInputHeight } from "./height";
import { createKeyHandler } from "./keys";
import {
  MIN_INPUT_HEIGHT_NATIVE,
  MIN_INPUT_HEIGHT_WEB,
  type PrimaryActionKind,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  resolveMaxInputHeight,
  resolvePrimaryAction,
  type SendAction,
  type SendBehavior,
  submitAccessibilityLabel,
} from "./logic";
import { useSending, useStopAgent } from "./sending";
import { useSendBehavior } from "./storage";

type Colors = PluginTheme["colors"];
type Permission = PaseoAgent["pendingPermissions"][number];

const web = Platform.OS === "web";

export interface ComposerProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  agentId: string | null;
  running: boolean;
  layout: ChatPaneProps["layout"];
  keyboardOpen: boolean;
  agent?: PaseoAgent | null;
  agentReady: boolean;
  onStart(message: OutgoingMessage): Promise<void>;
}

export type ChatComposerProps = ComposerProps & { draftKey: string };

function useComposerInput(text: string, layout: ComposerProps["layout"]) {
  const desktopWeb = layout.platform === "web" && !layout.compact;
  const outerRef = useRef<View>(null);
  const attachRef = useRef<View>(null);
  const inputRef = useRef<NativeTextInput>(null);
  const { height: windowHeight } = useWindowDimensions();
  const inputHeight = useInputHeight({
    inputRef,
    text,
    minHeight: web ? MIN_INPUT_HEIGHT_WEB : MIN_INPUT_HEIGHT_NATIVE,
    maxHeight: resolveMaxInputHeight(windowHeight),
    fontSize: content(),
  });
  const focusInput = () => {
    if (web) focusWithRetries(() => domNode(inputRef.current));
    else inputRef.current?.focus();
  };

  const focusOnOpen = useRef(desktopWeb);
  useEffect(() => (focusOnOpen.current ? focusWithRetries(() => domNode(inputRef.current)) : undefined), []);

  return { inputRef, inputHeight, focusInput, desktopWeb, outerRef, attachRef };
}

interface SendAvailability {
  canInterrupt: boolean;
  canPressLoading: boolean;
  sendDisabled: boolean;
  primary: PrimaryActionKind;
  sendLabel: string;
}

interface SendAvailabilityInput {
  running: boolean;
  permissions: Permission[];
  agentId: string | null;
  host: BotHost;
  loading: boolean;
  hasContent: boolean;
  behavior: SendBehavior;
  ready: boolean;
  newTask: boolean;
}

function sendAvailability({
  running,
  permissions,
  agentId,
  host,
  loading,
  hasContent,
  behavior,
  ready,
  newTask,
}: SendAvailabilityInput): SendAvailability {
  const canInterrupt = ready && running && permissions.length > 0 && agentId !== null && !!host.api;
  const canPressLoading = loading && canInterrupt && !newTask;
  return {
    canInterrupt,
    canPressLoading,
    sendDisabled: !ready || !host.api || (!canPressLoading && loading),
    primary: resolvePrimaryAction({ hasContent, running, loading }),
    sendLabel: newTask ? "Start new task" : submitAccessibilityLabel({ canPressLoading, behavior, running }),
  };
}

export function useComposerController({
  colors,
  bot,
  host,
  agentId,
  running,
  layout,
  agent,
  agentReady,
  onStart,
  draftKey,
}: ChatComposerProps) {
  const draft = useComposerDraft(draftKey);
  const kind = conversationKind({ agentId, agent, agentReady, isLocal: host.isLocal });
  const continuing = kind === "legacy" || kind === "remote";
  const newTask = startsNewTask(kind, bot, host.isLocal);
  const paste = usePasteSheet(draft);
  const sendBehavior = useSendBehavior();
  const permissions: Permission[] = agent?.pendingPermissions ?? [];
  const behavior = resolveActiveSendBehavior(sendBehavior, permissions.length > 0);
  const queue = useQueue(draftKey);
  const input = useComposerInput(draft.text, layout);
  const files = useFileAttachments({ draftKey, draft, botId: bot.id, isLocal: host.isLocal });
  const sending = useSending({
    draftKey,
    draft,
    target: { agentId, kind, host, sendBehavior, onStart },
    running,
    queue,
    focusInput: input.focusInput,
  });
  const loading = sending.processing || files.pending.length > 0;
  const availability = sendAvailability({
    running,
    permissions,
    agentId,
    host,
    loading,
    hasContent: draft.text.trim().length > 0 || draft.attachments.length > 0,
    behavior,
    ready: kind !== "loading",
    newTask,
  });
  const { stopping, stop } = useStopAgent({
    permissions,
    canInterrupt: availability.canInterrupt,
    agentId,
    api: host.api,
    focusInput: input.focusInput,
  });
  const openAttachMenu = useAttachmentSources({
    colors,
    host,
    inputRef: input.inputRef,
    outerRef: input.outerRef,
    attachRef: input.attachRef,
    loading,
    addFiles: files.addFiles,
    onPasteText: paste.show,
  });
  const commands = useSlashCommands(continuing ? agentId : null, host, draft, input.focusInput);

  const run = (action: SendAction) => {
    if (availability.sendDisabled || loading) return;
    if (action === "queue") sending.enqueue();
    else if (action === "send") void sending.send();
  };
  const defaultAction = () =>
    run(resolveDefaultAction({ behavior, running: continuing && running, canQueue: continuing }));

  return {
    ...availability,
    kind,
    newTask,
    notice: conversationNotice(kind, host.isLocal, bot.executionMode === "managed"),
    draft,
    input,
    outerRef: input.outerRef,
    attachRef: input.attachRef,
    queue,
    pending: files.pending,
    paste,
    sending,
    loading,
    stopping,
    interrupt: stop,
    onSend: availability.canPressLoading ? stop : defaultAction,
    openAttachMenu,
    commands,
    onKeyPress: createKeyHandler({
      enabled: layout.platform === "web",
      commands,
      canInterrupt: availability.canInterrupt,
      stop,
      enter: { submitOnEnter: input.desktopWeb, running: continuing && running, canQueue: continuing },
      blocked: availability.sendDisabled || loading,
      defaultAction,
      alternateAction: () =>
        run(resolveAlternateAction({ behavior, running: continuing && running, canQueue: continuing })),
    }),
  };
}
