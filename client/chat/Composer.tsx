import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsRow } from "@getpaseo/plugin/client/ui";
import {
  type Dispatch,
  type ReactNode,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  type TextInput as NativeTextInput,
  Platform,
  Pressable,
  Text,
  type TextStyle,
  useWindowDimensions,
  View,
} from "react-native";
import {
  type ComposerAttachment,
  newAttachmentId,
  normalizeMimeType,
  preflightFile,
  toWire,
} from "../../shared/attachments";
import type { Bot } from "../../shared/bot";
import { uploadRpc } from "../../shared/rpc";
import { expandLearn, LEARN_COMMAND } from "../../shared/skills";
import { AttachmentPill, PendingAttachmentPill } from "../AttachmentPill";
import type { ChatPaneProps, OutgoingMessage } from "../ChatPane";
import type { BotHost } from "../data";
import { homeIndicatorInset } from "../keyboard";
import { CONTENT_MAX_WIDTH, errorText, nativeTokens, placeholderColor, useHover } from "../native";
import type { PaseoAgent, PaseoAgentSendOptions, PaseoApi } from "../paseo";
import { newMessageId, rememberSent } from "../sent-attachments";
import { content, ui } from "../typography";
import { type MenuEntry, measureAnchor, useMenu } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";
import {
  decodeUtf8,
  domNode,
  type FileHandle,
  focusWithRetries,
  listenForFileDrop,
  listenForImagePaste,
  pickFileHandles,
} from "../web";
import { CommandMenu } from "./composer/CommandMenu";
import { ContextMeter } from "./composer/ContextMeter";
import {
  getDraft,
  loadDrafts,
  queueMessage,
  requeueFront,
  setDraft,
  takeQueuedMessage,
  useQueue,
} from "./composer/drafts";
import { useInputHeight } from "./composer/height";
import {
  activeTurnBehaviorFor,
  applyCommand,
  type ComposerKeyEvent,
  type ContextUsage,
  commandQuery,
  composerDraftKey,
  contextUsage,
  filterCommands,
  isDraftEmpty,
  isImeComposing,
  MIN_INPUT_HEIGHT_NATIVE,
  MIN_INPUT_HEIGHT_WEB,
  type PrimaryActionKind,
  type QueuedMessage,
  resolveActiveSendBehavior,
  resolveAlternateAction,
  resolveDefaultAction,
  resolveEnterKey,
  resolveMaxInputHeight,
  resolvePrimaryAction,
  restoreFailedSend,
  type SendAction,
  type SendBehavior,
  type SlashCommand,
  shouldDrainQueue,
  submitAccessibilityLabel,
  withPluginCommands,
} from "./composer/logic";
import { useSendBehavior } from "./composer/storage";

type Colors = PluginTheme["colors"];
type Permission = PaseoAgent["pendingPermissions"][number];

const web = Platform.OS === "web";
/** Paseo's palette: red-600 for the stop button, red-500 for inline send errors. */
const RED_600 = "#dc2626";
const RED_500 = "#ef4444";
const FAILED_TO_SEND = "Failed to send message";

interface ComposerProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  agentId: string | null;
  running: boolean;
  layout: ChatPaneProps["layout"];
  keyboardOpen: boolean;
  /** The chat's live agent snapshot: pending permissions (stop), last usage (context meter). */
  agent?: PaseoAgent | null;
  onStart(message: OutgoingMessage): Promise<void>;
}

/** One composer per chat, so each chat keeps its own draft, height and queue. */
export function Composer(props: ComposerProps) {
  const draftKey = composerDraftKey(props.host.key, props.bot.id, props.agentId);
  return <ChatComposer key={draftKey} draftKey={draftKey} {...props} />;
}

const PLUGIN_COMMANDS: SlashCommand[] = [{ ...LEARN_COMMAND, kind: "command" }];

interface CommandResult {
  commands: SlashCommand[];
  error: string | null;
}

// Commands are listed per live session; cache them per agent for the session.
const commandCache = new Map<string, Promise<CommandResult>>();

interface DraftMessage {
  text: string;
  attachments: ComposerAttachment[];
}

type DrainState = "idle" | "sending" | "awaiting" | "paused";

type ChatComposerProps = ComposerProps & { draftKey: string };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : FAILED_TO_SEND;
}

function useMountedRef(): RefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}

// ------------------------------------------------------------ drafts

interface ComposerDraftState {
  text: string;
  attachments: ComposerAttachment[];
  latest: RefObject<DraftMessage>;
  updateText(next: string): void;
  updateAttachments(update: (current: ComposerAttachment[]) => ComposerAttachment[]): void;
}

function useComposerDraft(draftKey: string): ComposerDraftState {
  const initial = useMemo(() => getDraft(draftKey), [draftKey]);
  const [text, setText] = useState(initial?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initial?.attachments ?? []);
  const touched = useRef(false);
  const latest = useRef<DraftMessage>({ text, attachments });
  latest.current = { text, attachments };

  const updateText = (next: string) => {
    touched.current = true;
    setText(next);
  };
  const updateAttachments = (update: (current: ComposerAttachment[]) => ComposerAttachment[]) => {
    touched.current = true;
    setAttachments(update);
  };

  // Phones read drafts from AsyncStorage after the first render; apply it unless the user already typed.
  useEffect(() => {
    let alive = true;
    void loadDrafts().then(() => {
      if (!alive || touched.current) return;
      const draft = getDraft(draftKey);
      if (draft) {
        setText(draft.text);
        setAttachments(draft.attachments);
      }
    });
    return () => {
      alive = false;
    };
  }, [draftKey]);

  useEffect(() => {
    if (touched.current) setDraft(draftKey, { text, attachments });
  }, [draftKey, text, attachments]);

  return { text, attachments, latest, updateText, updateAttachments };
}

// ------------------------------------------------------------ input

function useComposerInput(text: string, desktopWeb: boolean) {
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

  // Desktop web focuses the composer when a chat opens (Paseo's MessageInputAutoFocus).
  const focusOnOpen = useRef(desktopWeb);
  useEffect(() => (focusOnOpen.current ? focusWithRetries(() => domNode(inputRef.current)) : undefined), []);

  return { inputRef, inputHeight, focusInput };
}

// ------------------------------------------------------------ attachments

interface AcceptedFile {
  file: FileHandle;
  kind: ComposerAttachment["kind"];
  mimeType: string;
  pendingId: string;
}

interface PendingFile {
  id: string;
  name: string;
}

type StoreFile = (fileName: string, dataBase64: string) => Promise<{ size: number; path: string }>;

function acceptFiles(
  files: FileHandle[],
  isLocal: boolean,
  reject: (message: string) => void,
): AcceptedFile[] {
  const accepted: AcceptedFile[] = [];
  for (const file of files) {
    const mimeType = normalizeMimeType(file.mimeType) || "application/octet-stream";
    // Size limits are checked before any bytes are read.
    const { kind, reason } = preflightFile(file.name, mimeType, file.size, isLocal);
    if (reason) {
      reject(`${file.name}: ${reason}`);
      continue;
    }
    accepted.push({ file, kind, mimeType, pendingId: newAttachmentId() });
  }
  return accepted;
}

async function readAttachment(
  { file, kind, mimeType }: AcceptedFile,
  storeFile: StoreFile,
): Promise<ComposerAttachment> {
  const base64 = await file.readBase64();
  if (kind === "image")
    return { kind, id: newAttachmentId(), name: file.name, mimeType, size: file.size, data: base64 };
  if (kind === "text")
    return { kind, id: newAttachmentId(), name: file.name, size: file.size, text: decodeUtf8(base64) };
  const stored = await storeFile(file.name, base64);
  return { kind, id: newAttachmentId(), name: file.name, mimeType, size: stored.size, path: stored.path };
}

interface FileAttachmentOptions {
  draftKey: string;
  draft: ComposerDraftState;
  botId: string;
  isLocal: boolean;
}

function useFileAttachments({ draftKey, draft, botId, isLocal }: FileAttachmentOptions) {
  const toast = useToast();
  const upload = useRpc(uploadRpc);
  const mounted = useMountedRef();
  const [pending, setPending] = useState<PendingFile[]>([]);

  const attach = (attachment: ComposerAttachment) => {
    if (mounted.current) draft.updateAttachments((current) => [...current, attachment]);
    else
      setDraft(draftKey, {
        text: draft.latest.current.text,
        attachments: [...draft.latest.current.attachments, attachment],
      });
  };

  const addAccepted = async (entry: AcceptedFile, storeFile: StoreFile) => {
    try {
      attach(await readAttachment(entry, storeFile));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload file");
    } finally {
      if (mounted.current) setPending((current) => current.filter((item) => item.id !== entry.pendingId));
    }
  };

  const addFiles = async (files: FileHandle[]) => {
    const accepted = acceptFiles(files, isLocal, (message) => toast.error(message));
    if (accepted.length === 0) return;
    setPending((current) => [
      ...current,
      ...accepted.map((entry) => ({ id: entry.pendingId, name: entry.file.name })),
    ]);
    const storeFile: StoreFile = (fileName, dataBase64) => upload({ botId, fileName, dataBase64 });
    for (const entry of accepted) await addAccepted(entry, storeFile);
  };

  return { pending, addFiles };
}

interface AttachmentSourcesOptions {
  colors: Colors;
  host: BotHost;
  inputRef: RefObject<NativeTextInput | null>;
  outerRef: RefObject<View | null>;
  attachRef: RefObject<View | null>;
  loading: boolean;
  addFiles(files: FileHandle[]): Promise<void>;
  onPasteText(): void;
}

function useAttachmentSources({
  colors,
  host,
  inputRef,
  outerRef,
  attachRef,
  loading,
  addFiles,
  onPasteText,
}: AttachmentSourcesOptions) {
  const toast = useToast();
  const menu = useMenu();
  const addFilesRef = useRef(addFiles);
  addFilesRef.current = addFiles;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const pick = async (accept?: string) => {
    try {
      await addFiles(await pickFileHandles({ accept }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload file");
    }
  };

  const openAttachMenu = async () => {
    const anchor = await measureAnchor(attachRef);
    if (!anchor) return;
    // Paseo's order: Add image, Paste image (phones), issues/PRs, plugin sources, Upload file.
    // Plugins can't read the clipboard or open pickers on phones, so pasting text stands in there.
    const entries: MenuEntry[] = web
      ? [
          { label: "Add image", icon: "Image", onSelect: () => void pick("image/*") },
          { label: "Upload file", icon: "Paperclip", onSelect: () => void pick() },
        ]
      : [{ label: "Paste text", icon: "ClipboardPaste", onSelect: onPasteText }];
    menu.open({ anchor, align: "start", width: 220, title: "Add attachment", entries });
  };

  // Web: pasting images into the input attaches them.
  useEffect(
    () => listenForImagePaste(domNode(inputRef.current), (files) => void addFilesRef.current(files)),
    [inputRef],
  );

  // Web: dropping files anywhere on the chat pane attaches them (Paseo's FileDropZone).
  useEffect(() => {
    const own = domNode(outerRef.current);
    return listenForFileDrop(own?.parentElement ?? own, {
      label: "Drop files here",
      background: colors.surface0,
      foreground: colors.foreground,
      isEnabled: () => !loadingRef.current && !!host.api,
      onFiles: (files) => void addFilesRef.current(files),
    });
  }, [colors.surface0, colors.foreground, host.api, outerRef]);

  return openAttachMenu;
}

// ------------------------------------------------------------ sending

interface DeliveryTarget {
  agentId: string | null;
  host: BotHost;
  sendBehavior: SendBehavior;
  onStart(message: OutgoingMessage): Promise<void>;
}

async function deliverMessage(
  message: DraftMessage,
  { agentId, host, sendBehavior, onStart }: DeliveryTarget,
) {
  const typed = message.text.trim();
  // /learn only works where the plugin's tools are mounted (bots on this host).
  const outgoing =
    (agentId && host.isLocal ? expandLearn(typed) : null) ?? (typed || "See the attached files.");
  const messageId = newMessageId();
  const wire = toWire(message.attachments);
  rememberSent(messageId, outgoing, message.attachments);
  if (!agentId || !host.api) {
    await onStart({ text: outgoing, messageId, ...wire });
    return;
  }
  // `activeTurnBehavior` is forwarded to the daemon as-is (send_agent_message_request).
  const options = {
    messageId,
    activeTurnBehavior: activeTurnBehaviorFor(sendBehavior),
    ...(wire.images.length ? { images: wire.images } : {}),
    ...(wire.attachments.length ? { attachments: wire.attachments } : {}),
  } as PaseoAgentSendOptions;
  await host.api.agents.ref(agentId).send(outgoing, options);
}

interface QueueDrainOptions {
  draftKey: string;
  running: boolean;
  queue: QueuedMessage[];
  processing: boolean;
  agentId: string | null;
  api: PaseoApi | null;
  deliver(message: DraftMessage): Promise<void>;
  onError(message: string): void;
}

// Queued messages go out one at a time whenever the agent is idle (Paseo drains on "stopped running").
function useQueueDrain({
  draftKey,
  running,
  queue,
  processing,
  agentId,
  api,
  deliver,
  onError,
}: QueueDrainOptions) {
  const [drain, setDrain] = useState<DrainState>("idle");
  const mounted = useMountedRef();
  const draining = useRef(false);
  const latest = useRef({ deliver, onError });
  latest.current = { deliver, onError };

  useEffect(() => {
    if (running && (drain === "awaiting" || drain === "paused")) setDrain("idle");
  }, [running, drain]);
  useEffect(() => {
    if (drain !== "awaiting") return;
    const timer = setTimeout(() => setDrain((current) => (current === "awaiting" ? "idle" : current)), 4000);
    return () => clearTimeout(timer);
  }, [drain]);
  useEffect(() => {
    const inFlight = draining.current || drain !== "idle" || processing;
    const hasAgent = agentId !== null && !!api;
    const head = queue[0];
    if (!head || !shouldDrainQueue({ running, queued: queue.length, inFlight, hasAgent })) return;
    const next = takeQueuedMessage(draftKey, head.id);
    if (!next) return;
    draining.current = true;
    setDrain("sending");
    latest.current
      .deliver(next)
      .then(() => mounted.current && setDrain("awaiting"))
      .catch((error: unknown) => {
        requeueFront(draftKey, next);
        if (!mounted.current) return;
        latest.current.onError(errorMessage(error));
        setDrain("paused");
      })
      .finally(() => {
        draining.current = false;
      });
  }, [running, queue, drain, processing, agentId, api, draftKey, mounted]);

  return { drain, setDrain };
}

interface SendingOptions {
  draftKey: string;
  draft: ComposerDraftState;
  target: DeliveryTarget;
  running: boolean;
  queue: QueuedMessage[];
  focusInput(): void;
}

function useSending({ draftKey, draft, target, running, queue, focusInput }: SendingOptions) {
  const toast = useToast();
  const mounted = useMountedRef();
  const [processing, setProcessing] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const deliver = (message: DraftMessage) => deliverMessage(message, target);
  const { drain, setDrain } = useQueueDrain({
    draftKey,
    running,
    queue,
    processing,
    agentId: target.agentId,
    api: target.host.api,
    deliver,
    onError: setSendError,
  });

  const clearDraft = () => {
    draft.updateText("");
    draft.updateAttachments(() => []);
  };

  const restoreFailedMessage = (message: DraftMessage, error: unknown) => {
    const restored = restoreFailedSend(message, draft.latest.current);
    if (mounted.current) {
      draft.updateText(restored.text);
      draft.updateAttachments(() => restored.attachments);
      setSendError(errorMessage(error));
    } else {
      setDraft(draftKey, restored);
      toast.error(errorMessage(error));
    }
  };

  // Give the agent a moment to report the new turn before any queued message drains.
  const awaitNewTurn = () => {
    if (target.agentId && mounted.current) setDrain((current) => (current === "idle" ? "awaiting" : current));
  };

  // composer/submit.ts: clear at once so typing can continue, put everything back on failure.
  const send = async () => {
    const message = { text: draft.text.trim(), attachments: draft.attachments };
    if (isDraftEmpty(message) || !target.host.api) return;
    clearDraft();
    setSendError(null);
    setProcessing(true);
    if (drain === "paused") setDrain("idle");
    try {
      await deliver(message);
      awaitNewTurn();
    } catch (error) {
      restoreFailedMessage(message, error);
    } finally {
      if (mounted.current) setProcessing(false);
    }
  };

  const enqueue = () => {
    const message = { text: draft.text.trim(), attachments: draft.attachments };
    if (isDraftEmpty(message)) return;
    queueMessage(draftKey, { id: newMessageId(), ...message });
    clearDraft();
  };

  const sendQueuedNow = async (item: QueuedMessage) => {
    if (!target.host.api || !takeQueuedMessage(draftKey, item.id)) return;
    setSendError(null);
    try {
      await deliver(item);
    } catch (error) {
      requeueFront(draftKey, item);
      if (mounted.current) setSendError(errorMessage(error));
    }
  };

  const editQueued = (item: QueuedMessage) => {
    if (!takeQueuedMessage(draftKey, item.id)) return;
    draft.updateText(item.text);
    draft.updateAttachments(() => item.attachments);
    focusInput();
  };

  return { processing, sendError, send, enqueue, sendQueuedNow, editQueued };
}

// ------------------------------------------------------------ stop

interface StopAgentOptions {
  permissions: Permission[];
  canInterrupt: boolean;
  agentId: string | null;
  api: PaseoApi | null;
  focusInput(): void;
}

// Plugins have no cancel API. The one interrupt path is a pending permission: denying it
// with `interrupt` ends the turn, which is what Paseo's stop does in that state.
function useStopAgent({ permissions, canInterrupt, agentId, api, focusInput }: StopAgentOptions) {
  const toast = useToast();
  const mounted = useMountedRef();
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    const permission = permissions[0];
    if (!canInterrupt || !permission || !agentId || !api || stopping) return;
    setStopping(true);
    try {
      await api.agents.ref(agentId).respondToPermission({
        requestId: permission.id,
        response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." },
      });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      if (mounted.current) setStopping(false);
    }
    focusInput();
  };
  return { stopping, stop };
}

// ------------------------------------------------------------ /commands

function cachedCommands(agentId: string, api: PaseoApi): Promise<CommandResult> {
  const cached = commandCache.get(agentId);
  if (cached) return cached;
  const promise = api.agents
    .ref(agentId)
    .commands()
    .then((result) => ({ commands: result.commands as SlashCommand[], error: result.error }))
    .catch((error: unknown) => ({ commands: [], error: errorText(error) }));
  commandCache.set(agentId, promise);
  // Don't cache failures: the next chat visit asks again.
  void promise.then((result) => result.error && commandCache.delete(agentId));
  return promise;
}

interface SlashCommandsState {
  visible: boolean;
  list: SlashCommand[];
  activeIndex: number;
  setActiveIndex: Dispatch<SetStateAction<number>>;
  loading: boolean;
  error: string | null;
  dismiss(): void;
  select(command: SlashCommand): void;
}

function useSlashCommands(
  agentId: string | null,
  host: BotHost,
  draft: ComposerDraftState,
  focusInput: () => void,
): SlashCommandsState {
  const [commandState, setCommandState] = useState<(CommandResult & { agentId: string }) | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const query = agentId ? commandQuery(draft.text) : null;
  const visible = query !== null && !dismissed;
  const loadedFor = useRef(commandState?.agentId);
  loadedFor.current = commandState?.agentId;

  useEffect(() => {
    if (query === null) setDismissed(false);
    setActiveIndex(0);
  }, [query]);
  useEffect(() => {
    if (!visible || !agentId || !host.api || loadedFor.current === agentId) return;
    let alive = true;
    void cachedCommands(agentId, host.api).then((result) => alive && setCommandState({ agentId, ...result }));
    return () => {
      alive = false;
    };
  }, [visible, agentId, host.api]);

  const loaded = commandState?.agentId === agentId ? commandState : null;
  const list = visible
    ? filterCommands(
        withPluginCommands(host.isLocal ? PLUGIN_COMMANDS : [], loaded?.commands ?? []),
        query ?? "",
      )
    : [];
  return {
    visible,
    list,
    activeIndex,
    setActiveIndex,
    loading: loaded === null,
    error: loaded?.error ?? null,
    dismiss: () => setDismissed(true),
    select: (command) => {
      draft.updateText(applyCommand(command));
      setDismissed(true);
      focusInput();
    },
  };
}

// ------------------------------------------------------------ keys

type KeyEffect = (() => void) | null;

interface KeyHandlerOptions {
  enabled: boolean;
  commands: SlashCommandsState;
  canInterrupt: boolean;
  stop(): void;
  enter: { submitOnEnter: boolean; running: boolean; canQueue: boolean };
  blocked: boolean;
  defaultAction(): void;
  alternateAction(): void;
}

function commandMenuKeyEffect(key: ComposerKeyEvent, { commands }: KeyHandlerOptions): KeyEffect {
  if (!commands.visible) return null;
  if (key.key === "Escape") return commands.dismiss;
  const count = commands.list.length;
  if (count === 0) return null;
  if (key.key === "ArrowDown") return () => commands.setActiveIndex((index) => (index + 1) % count);
  if (key.key === "ArrowUp") return () => commands.setActiveIndex((index) => (index - 1 + count) % count);
  if ((key.key !== "Enter" || key.shiftKey) && key.key !== "Tab") return null;
  const command = commands.list[Math.min(commands.activeIndex, count - 1)];
  return command ? () => commands.select(command) : null;
}

function composerKeyEffect(key: ComposerKeyEvent, options: KeyHandlerOptions): KeyEffect {
  // Paseo's Escape shortcut interrupts the agent.
  if (key.key === "Escape" && options.canInterrupt) return options.stop;
  const action = resolveEnterKey(key, options.enter);
  // While a send or upload is in flight Enter falls through to a newline, like Paseo.
  if (!action || options.blocked) return null;
  return action === "alternate" ? options.alternateAction : options.defaultAction;
}

function createKeyHandler(options: KeyHandlerOptions) {
  return (event: { nativeEvent: unknown; preventDefault?: () => void }) => {
    if (!options.enabled) return;
    const key = event.nativeEvent as ComposerKeyEvent;
    if (isImeComposing(key)) return;
    const effect = commandMenuKeyEffect(key, options) ?? composerKeyEffect(key, options);
    if (!effect) return;
    event.preventDefault?.();
    effect();
  };
}

// ------------------------------------------------------------ controller

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
}

function sendAvailability({
  running,
  permissions,
  agentId,
  host,
  loading,
  hasContent,
  behavior,
}: SendAvailabilityInput): SendAvailability {
  const canInterrupt = running && permissions.length > 0 && agentId !== null && !!host.api;
  const canPressLoading = loading && canInterrupt;
  return {
    canInterrupt,
    canPressLoading,
    sendDisabled: !host.api || (!canPressLoading && loading),
    primary: resolvePrimaryAction({ hasContent, running, loading }),
    sendLabel: submitAccessibilityLabel({ canPressLoading, behavior, running }),
  };
}

function usePasteSheet(draft: ComposerDraftState) {
  const [open, setOpen] = useState(false);
  const attach = (pasted: string, title: string) => {
    draft.updateAttachments((current) => [
      ...current,
      { kind: "text", id: newAttachmentId(), name: title, size: pasted.length, text: pasted },
    ]);
    setOpen(false);
  };
  return { open, show: () => setOpen(true), close: () => setOpen(false), attach };
}

function useComposerController({
  colors,
  bot,
  host,
  agentId,
  running,
  layout,
  agent,
  onStart,
  draftKey,
}: ChatComposerProps) {
  const draft = useComposerDraft(draftKey);
  const paste = usePasteSheet(draft);
  const outerRef = useRef<View>(null);
  const attachRef = useRef<View>(null);
  const sendBehavior = useSendBehavior();
  const permissions: Permission[] = agent?.pendingPermissions ?? [];
  const behavior = resolveActiveSendBehavior(sendBehavior, permissions.length > 0);
  const queue = useQueue(draftKey);
  const canQueue = agentId !== null;
  const desktopWeb = layout.platform === "web" && !layout.compact;
  const input = useComposerInput(draft.text, desktopWeb);
  const files = useFileAttachments({ draftKey, draft, botId: bot.id, isLocal: host.isLocal });
  const sending = useSending({
    draftKey,
    draft,
    target: { agentId, host, sendBehavior, onStart },
    running,
    queue,
    focusInput: input.focusInput,
  });
  const loading = sending.processing || files.pending.length > 0;
  const hasContent = draft.text.trim().length > 0 || draft.attachments.length > 0;
  const availability = sendAvailability({
    running,
    permissions,
    agentId,
    host,
    loading,
    hasContent,
    behavior,
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
    outerRef,
    attachRef,
    loading,
    addFiles: files.addFiles,
    onPasteText: paste.show,
  });
  const commands = useSlashCommands(agentId, host, draft, input.focusInput);

  const run = (action: SendAction) => {
    if (action === "queue") sending.enqueue();
    else if (action === "send") void sending.send();
  };
  const defaultAction = () => run(resolveDefaultAction({ behavior, running, canQueue }));
  const interrupt = () => void stop();

  const onKeyPress = createKeyHandler({
    enabled: layout.platform === "web",
    commands,
    canInterrupt: availability.canInterrupt,
    stop: interrupt,
    enter: { submitOnEnter: desktopWeb, running, canQueue },
    blocked: availability.sendDisabled || loading,
    defaultAction,
    alternateAction: () => run(resolveAlternateAction({ behavior, running, canQueue })),
  });

  return {
    ...availability,
    draft,
    input,
    outerRef,
    attachRef,
    queue,
    pending: files.pending,
    paste,
    sending,
    loading,
    stopping,
    interrupt,
    onSend: availability.canPressLoading ? interrupt : defaultAction,
    openAttachMenu,
    commands,
    onKeyPress,
  };
}

// ------------------------------------------------------------ render

function composerPlaceholder(botName: string, agentId: string | null, compact: boolean): string {
  if (!agentId) return `Message ${botName}`;
  return compact ? "Message, /commands" : `Message ${botName}, or use /commands and /skills`;
}

function QueueList({
  colors,
  queue,
  onEdit,
  onSendNow,
}: {
  colors: Colors;
  queue: QueuedMessage[];
  onEdit(item: QueuedMessage): void;
  onSendNow(item: QueuedMessage): void;
}) {
  if (queue.length === 0) return null;
  return (
    <View style={{ gap: 8 }}>
      {queue.map((item) => (
        <QueuedRow
          key={item.id}
          colors={colors}
          item={item}
          onEdit={() => onEdit(item)}
          onSendNow={() => onSendNow(item)}
        />
      ))}
    </View>
  );
}

function AttachmentTray({
  colors,
  attachments,
  pending,
  alwaysShowRemove,
  disabled,
  onRemove,
}: {
  colors: Colors;
  attachments: ComposerAttachment[];
  pending: PendingFile[];
  alwaysShowRemove: boolean;
  disabled: boolean;
  onRemove(id: string): void;
}) {
  if (attachments.length === 0 && pending.length === 0) return null;
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {attachments.map((attachment) => (
        <AttachmentPill
          key={attachment.id}
          colors={colors}
          attachment={attachment}
          alwaysShowRemove={alwaysShowRemove}
          disabled={disabled}
          onRemove={() => onRemove(attachment.id)}
        />
      ))}
      {pending.map((entry) => (
        <PendingAttachmentPill key={entry.id} colors={colors} name={entry.name} />
      ))}
    </View>
  );
}

interface ComposerTextInputProps {
  colors: Colors;
  inputRef: RefObject<NativeTextInput | null>;
  botName: string;
  placeholder: string;
  text: string;
  onChangeText(next: string): void;
  editable: boolean;
  onKeyPress(event: { nativeEvent: unknown; preventDefault?: () => void }): void;
  height: { style: TextStyle; scrollEnabled: boolean };
}

function ComposerTextInput({
  colors,
  inputRef,
  botName,
  placeholder,
  text,
  onChangeText,
  editable,
  onKeyPress,
  height,
}: ComposerTextInputProps) {
  const webInputStyle = web
    ? ({ lineHeight: content() * 1.4, outlineStyle: "none", outlineWidth: 0 } as object)
    : null;
  return (
    <TextInput
      ref={inputRef}
      accessibilityLabel={`Message ${botName}`}
      value={text}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={placeholderColor(colors)}
      multiline
      scrollEnabled={height.scrollEnabled}
      editable={editable}
      onKeyPress={onKeyPress}
      style={[
        {
          flexShrink: 1,
          width: "100%",
          color: colors.foreground,
          fontSize: content(),
          fontWeight: "normal",
          padding: 0,
          textAlignVertical: "top",
        },
        webInputStyle,
        height.style,
      ]}
    />
  );
}

interface PrimaryButtonProps {
  colors: Colors;
  primary: PrimaryActionKind;
  iconSize: number;
  sendLabel: string;
  sendDisabled: boolean;
  loading: boolean;
  canInterrupt: boolean;
  stopping: boolean;
  onSend(): void;
  onStop(): void;
}

function PrimaryButton({
  colors,
  primary,
  iconSize,
  sendLabel,
  sendDisabled,
  loading,
  canInterrupt,
  stopping,
  onSend,
  onStop,
}: PrimaryButtonProps) {
  if (primary === "send") {
    return (
      <RoundButton label={sendLabel} background={colors.accent} disabled={sendDisabled} onPress={onSend}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.accentForeground} />
        ) : (
          <Icon name="ArrowUp" size={iconSize} color={colors.accentForeground} />
        )}
      </RoundButton>
    );
  }
  if (primary !== "active" || !canInterrupt) return null;
  return (
    <RoundButton
      label={stopping ? "Canceling agent" : "Stop agent"}
      background={RED_600}
      disabled={stopping}
      onPress={onStop}
    >
      {stopping ? <ActivityIndicator size="small" color="#ffffff" /> : <FilledSquare size={iconSize} />}
    </RoundButton>
  );
}

function ContextMeterSlot({
  colors,
  usage,
  pending,
  glyphSize,
}: {
  colors: Colors;
  usage: ContextUsage | null;
  pending: boolean;
  glyphSize: number;
}) {
  return (
    <View
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ContextMeter colors={colors} usage={usage} pending={pending} glyphSize={glyphSize} />
    </View>
  );
}

function ComposerToolbar({
  colors,
  attachRef,
  iconSize,
  attachDisabled,
  onAttach,
  children,
}: {
  colors: Colors;
  attachRef: RefObject<View | null>;
  iconSize: number;
  attachDisabled: boolean;
  onAttach(): void;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "space-between",
        marginHorizontal: -6,
      }}
    >
      <View
        style={{
          minWidth: 0,
          flexShrink: 1,
          flexGrow: 1,
          flexDirection: "row",
          alignItems: "flex-end",
        }}
      >
        <AttachButton
          colors={colors}
          anchorRef={attachRef}
          iconSize={iconSize}
          disabled={attachDisabled}
          onPress={onAttach}
        />
      </View>
      <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>{children}</View>
    </View>
  );
}

function ComposerCard({
  colors,
  compact,
  children,
}: {
  colors: Colors;
  compact: boolean;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexShrink: 1,
        gap: 12,
        backgroundColor: colors.surface1,
        borderWidth: 1,
        borderColor: nativeTokens(colors).borderAccent,
        borderRadius: 16,
        paddingVertical: compact ? 8 : 16,
        paddingHorizontal: compact ? 12 : 16,
      }}
    >
      {children}
    </View>
  );
}

function SendErrorText({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Text accessibilityRole="alert" style={{ color: RED_500, fontSize: ui(14) }}>
      {message}
    </Text>
  );
}

// Paseo's composer (composer/index.tsx + composer/input/input.tsx): the queue track and any
// send error above a surface1 card with a borderAccent frame, radius 16; attachment tray,
// auto-growing input, then a toolbar with "Add attachment" on the left and the context
// meter and send/stop button on the right.
function ChatComposer(props: ChatComposerProps) {
  const { colors, bot, host, agentId, running, layout, keyboardOpen, agent } = props;
  const composer = useComposerController(props);
  const { draft, commands, sending, paste } = composer;
  const buttonIconSize = web ? 16 : 20;

  return (
    <View
      ref={composer.outerRef}
      collapsable={false}
      style={{
        width: "100%",
        minHeight: 75,
        alignItems: "center",
        paddingHorizontal: 16,
        paddingBottom: 16 + (keyboardOpen ? 0 : homeIndicatorInset()),
        flexShrink: 1,
      }}
    >
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, gap: 12, flexShrink: 1 }}>
        <QueueList
          colors={colors}
          queue={composer.queue}
          onEdit={sending.editQueued}
          onSendNow={(item) => void sending.sendQueuedNow(item)}
        />
        <SendErrorText message={sending.sendError} />
        <View style={{ position: "relative", width: "100%", flexShrink: 1 }}>
          {commands.visible ? (
            <CommandMenu
              colors={colors}
              commands={commands.list}
              activeIndex={commands.activeIndex}
              loading={commands.loading}
              error={commands.error}
              onHover={commands.setActiveIndex}
              onSelect={commands.select}
            />
          ) : null}
          <ComposerCard colors={colors} compact={layout.compact}>
            <AttachmentTray
              colors={colors}
              attachments={draft.attachments}
              pending={composer.pending}
              alwaysShowRemove={!web || layout.compact}
              disabled={sending.processing}
              onRemove={(id) =>
                draft.updateAttachments((current) => current.filter((entry) => entry.id !== id))
              }
            />
            <ComposerTextInput
              colors={colors}
              inputRef={composer.input.inputRef}
              botName={bot.name}
              placeholder={composerPlaceholder(bot.name, agentId, layout.compact)}
              text={draft.text}
              onChangeText={draft.updateText}
              editable={!!host.api}
              onKeyPress={composer.onKeyPress}
              height={composer.input.inputHeight}
            />
            <ComposerToolbar
              colors={colors}
              attachRef={composer.attachRef}
              iconSize={buttonIconSize}
              attachDisabled={!host.api}
              onAttach={() => void composer.openAttachMenu()}
            >
              {agentId ? (
                <ContextMeterSlot
                  colors={colors}
                  usage={contextUsage(agent?.lastUsage)}
                  pending={agent?.status === "initializing" || running}
                  glyphSize={layout.compact ? 16 : buttonIconSize}
                />
              ) : null}
              <PrimaryButton
                colors={colors}
                primary={composer.primary}
                iconSize={buttonIconSize}
                sendLabel={composer.sendLabel}
                sendDisabled={composer.sendDisabled}
                loading={composer.loading}
                canInterrupt={composer.canInterrupt}
                stopping={composer.stopping}
                onSend={composer.onSend}
                onStop={composer.interrupt}
              />
            </ComposerToolbar>
          </ComposerCard>
        </View>
      </View>
      {paste.open ? <PasteTextSheet colors={colors} onClose={paste.close} onAttach={paste.attach} /> : null}
    </View>
  );
}

/** Paseo's "Add attachment" trigger: 28 round, Plus muted, foreground and surface2 on hover. */
function AttachButton({
  colors,
  anchorRef,
  iconSize,
  disabled,
  onPress,
}: {
  colors: Colors;
  anchorRef: RefObject<View | null>;
  iconSize: number;
  disabled: boolean;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add attachment"
      {...tooltip("Add attachment")}
      disabled={disabled}
      onPress={onPress}
      {...hoverProps}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered ? colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        ref={anchorRef}
        collapsable={false}
        style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="Plus" size={iconSize} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

/** Paseo's 28pt round send / stop button. */
function RoundButton({
  label,
  background,
  disabled,
  onPress,
  children,
}: {
  label: string;
  background: string;
  disabled: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label)}
      disabled={disabled}
      onPress={onPress}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        marginLeft: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: background,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </Pressable>
  );
}

/** Lucide's Square filled white (the plugin Icon has no fill): an 18/24 box with a 2/24 radius. */
function FilledSquare({ size }: { size: number }) {
  const side = Math.round((size * 18) / 24);
  return (
    <View style={{ width: side, height: side, borderRadius: (size * 2) / 24, backgroundColor: "#ffffff" }} />
  );
}

/** Paseo's queued message row: text over two lines, a pencil to edit and an accent arrow to send now. */
function QueuedRow({
  colors,
  item,
  onEdit,
  onSendNow,
}: {
  colors: Colors;
  item: QueuedMessage;
  onEdit(): void;
  onSendNow(): void;
}) {
  const label = item.text || item.attachments.map((attachment) => attachment.name).join(", ");
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface1,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
      }}
    >
      <Text
        numberOfLines={2}
        ellipsizeMode="tail"
        style={{ flex: 1, color: colors.foreground, fontSize: ui(14) }}
      >
        {label}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Edit queued message"
          {...tooltip("Edit")}
          onPress={onEdit}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.surface2,
          }}
        >
          <Icon name="Pencil" size={14} color={colors.foreground} />
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send queued message now"
          {...tooltip("Send now")}
          onPress={onSendNow}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: colors.accent,
          }}
        >
          <Icon name="ArrowUp" size={14} color={colors.accentForeground} />
        </Pressable>
      </View>
    </View>
  );
}

/** Phones have no file picker or clipboard access for plugins, so "Paste text" attaches pasted text there. */
function PasteTextSheet({
  colors,
  onClose,
  onAttach,
}: {
  colors: Colors;
  onClose(): void;
  onAttach(text: string, title: string): void;
}) {
  const [text, setText] = useState("");
  const tokens = nativeTokens(colors);
  return (
    <Modal title="Paste text" open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <SettingsCard>
          <SettingsRow
            label="Text"
            hint="Pasted notes, an email, a log… sent alongside your message. Images and files can be attached from Paseo on desktop or the web."
          >
            <TextInput
              accessibilityLabel="Text to attach"
              value={text}
              onChangeText={setText}
              multiline
              placeholder="Paste here"
              placeholderTextColor={placeholderColor(colors)}
              style={{
                width: "100%",
                minHeight: 140,
                color: colors.foreground,
                backgroundColor: colors.surface1,
                borderColor: tokens.borderAccent,
                borderWidth: 1,
                borderRadius: 8,
                padding: 10,
                fontSize: ui(14),
                textAlignVertical: "top",
              }}
            />
          </SettingsRow>
          <SettingsAction
            label="Attach it to the message"
            actionLabel="Attach"
            disabled={!text.trim()}
            onPress={() => onAttach(text, `Pasted text (${text.trim().split(/\s+/).length} words)`)}
          />
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}
