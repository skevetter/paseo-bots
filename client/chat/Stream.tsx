import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList, Icon } from "@getpaseo/plugin/client/react-native";
import {
  memo,
  type ReactElement,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Animated,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
  type FlatList as NativeFlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import type { ComposerAttachment } from "../../shared/attachments";
import type { BotVoice } from "../../shared/bot";
import { CONTENT_MAX_WIDTH, nativeTokens } from "../native";
import type { PaseoApi } from "../paseo";
import { sentAttachments } from "../sent-attachments";
import { canSpeak, speak, stopSpeaking } from "../speech";
import { ui } from "../typography";
import { tooltip } from "../ui/Tooltip";
import type { ChatState } from "../useChat";
import { FindBar } from "./FindBar";
import { PermissionCard } from "./Permission";
import {
  buildRows,
  findRows,
  layoutStream,
  retainLayout,
  type StreamEntry,
  type StreamLayout,
  type StreamLayoutItem,
  type StreamRow,
} from "./stream/model";
import { CompletedTurnFooter, RowContent, type RowContext, RowFrame, WorkingIndicator } from "./stream/rows";
import { SecondaryButton } from "./stream/ui";

type Colors = PluginTheme["colors"];

// Paseo's agent stream (agent-stream/view.tsx with strategy-web.tsx and
// strategy-native.tsx): a forward list on web that follows new output only while
// you're within 64px of the bottom, an inverted list on phones (32px), older
// history paged in 40 at a time within 96px of the top, and a round
// "scroll to bottom" button when you've scrolled away.
const WEB_NEAR_BOTTOM = 64;
const NATIVE_NEAR_BOTTOM = 32;
const HISTORY_START_THRESHOLD = 96;
const EMPTY_ATTACHMENTS: ComposerAttachment[] = [];

export interface ChatStreamProps {
  colors: Colors;
  chat: ChatState;
  api: PaseoApi | null;
  agentId: string | null;
  compact: boolean;
  platform: "ios" | "android" | "web";
  /** Bumps when Paseo's font sizes change, so rows re-render. */
  typeVersion: number;
  onOpenChat?(chatId: string): void;
  /** Set for bots on this host, whose approval cards can save commands. */
  botId?: string;
  /** How the bot's turns are read aloud. */
  voice?: BotVoice;
  /** Whether the find bar is open. */
  findOpen?: boolean;
  onCloseFind?(): void;
}

/** Whether a turn is running, as the stream shows it. */
function isTurnRunning(chat: ChatState): boolean {
  return chat.agent?.status === "running" || chat.agent?.status === "initializing";
}

type ListRef = RefObject<NativeFlatList<StreamLayoutItem> | null>;

function useStreamLayout(chat: ChatState, running: boolean): StreamLayout {
  const previousLayout = useRef<StreamLayout | null>(null);
  return useMemo(() => {
    const next = retainLayout(
      previousLayout.current,
      layoutStream(buildRows(chat.entries as unknown as StreamEntry[], running), running),
    );
    previousLayout.current = next;
    return next;
  }, [chat.entries, running]);
}

interface StreamScrollOptions {
  list: ListRef;
  inverted: boolean;
  chat: ChatState;
  items: readonly StreamLayoutItem[];
}

// Sending a message jumps back to the bottom, like Paseo's bottom anchor on submit.
function useJumpToBottomOnSend(
  items: readonly StreamLayoutItem[],
  scrollToBottom: (animated: boolean) => void,
) {
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    const last = items.at(-1)?.row;
    const key = last?.key ?? null;
    if (key && key !== lastKey.current && last?.kind === "user" && lastKey.current !== null)
      scrollToBottom(false);
    lastKey.current = key;
  }, [items, scrollToBottom]);
}

interface StreamScrollHandlers {
  onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onContentSizeChange(width: number, height: number): void;
  onLayout(event: LayoutChangeEvent): void;
}

interface StreamScroll extends StreamScrollHandlers {
  nearBottom: boolean;
  scrollToBottom(animated: boolean): void;
}

function useStreamScroll({ list, inverted, chat, items }: StreamScrollOptions): StreamScroll {
  const [nearBottom, setNearBottom] = useState(true);
  const nearBottomRef = useRef(true);
  const metrics = useRef({ offset: 0, content: 0, viewport: 0 });
  /** Set while an older page loads on web, so content added above doesn't move the reader. */
  const olderAnchor = useRef(false);

  const updateNearBottom = useCallback((value: boolean) => {
    nearBottomRef.current = value;
    setNearBottom((current) => (current === value ? current : value));
  }, []);

  const scrollToBottom = useCallback(
    (animated: boolean) => {
      updateNearBottom(true);
      if (inverted) list.current?.scrollToOffset({ offset: 0, animated });
      else list.current?.scrollToEnd({ animated });
    },
    [inverted, list, updateNearBottom],
  );

  const maybeLoadOlder = () => {
    const { offset, content, viewport } = metrics.current;
    const fromStart = inverted ? content - viewport - offset : offset;
    if (fromStart > HISTORY_START_THRESHOLD || !chat.hasOlder || chat.loadingOlder || content <= 0) return;
    if (!inverted) olderAnchor.current = true;
    chat.loadOlder();
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    metrics.current = {
      offset: contentOffset.y,
      content: contentSize.height,
      viewport: layoutMeasurement.height,
    };
    const distance = inverted
      ? contentOffset.y
      : contentSize.height - (contentOffset.y + layoutMeasurement.height);
    updateNearBottom(distance <= (inverted ? NATIVE_NEAR_BOTTOM : WEB_NEAR_BOTTOM));
    maybeLoadOlder();
  };

  const holdReaderPosition = (height: number, previous: number) => {
    const delta = height - previous;
    if (delta === 0 || previous <= 0) return;
    const offset = Math.max(0, metrics.current.offset + delta);
    list.current?.scrollToOffset({ offset, animated: false });
    metrics.current.offset = offset;
  };

  const followWebContent = (height: number, previous: number) => {
    // Older history (and its spinner) went in above: keep the reader where they were.
    if (olderAnchor.current && !nearBottomRef.current) holdReaderPosition(height, previous);
    else if (nearBottomRef.current && height !== previous) list.current?.scrollToEnd({ animated: false });
  };

  const onContentSizeChange = (_width: number, height: number) => {
    const previous = metrics.current.content;
    metrics.current.content = height;
    // A short page that doesn't fill the viewport never scrolls, so check the history start here too.
    if (inverted || height <= metrics.current.viewport + HISTORY_START_THRESHOLD) maybeLoadOlder();
    if (!inverted) followWebContent(height, previous);
  };

  const onLayout = (event: LayoutChangeEvent) => {
    metrics.current.viewport = event.nativeEvent.layout.height;
    if (!inverted && nearBottomRef.current) list.current?.scrollToEnd({ animated: false });
  };

  useEffect(() => {
    if (!chat.loadingOlder) {
      // A page that added nothing above (all duplicates) leaves no anchor to apply.
      const timer = setTimeout(() => (olderAnchor.current = false), 500);
      return () => clearTimeout(timer);
    }
  }, [chat.loadingOlder]);

  useJumpToBottomOnSend(items, scrollToBottom);

  return { nearBottom, scrollToBottom, onScroll, onContentSizeChange, onLayout };
}

interface StreamFindOptions {
  list: ListRef;
  items: readonly StreamLayoutItem[];
  inverted: boolean;
  findOpen: boolean;
  chat: ChatState;
}

function useStreamFind({ list, items, inverted, findOpen, chat }: StreamFindOptions) {
  const [query, setQuery] = useState("");
  /** The current match's row key. */
  const [found, setFound] = useState<string | null>(null);
  /** Pages loaded so far looking for an older match; 0 when not looking. */
  const [olderPages, setOlderPages] = useState(0);
  const needle = findOpen ? query.trim().toLowerCase() : "";
  const matches = useMemo(() => findRows(items, needle), [items, needle]);
  const position = matches.findIndex((index) => items[index]?.row.key === found);

  const reveal = useCallback(
    (itemIndex: number) => {
      const item = items[itemIndex];
      if (!item) return;
      setFound(item.row.key);
      // A first jump near the row; on the web the row then centres itself once it renders.
      list.current?.scrollToIndex({
        index: inverted ? items.length - 1 - itemIndex : itemIndex,
        animated: inverted,
        viewPosition: 0.3,
      });
    },
    [items, inverted, list],
  );

  // A new search starts at the newest match.
  const searchedNeedle = useRef<string | null>(null);
  useEffect(() => {
    if (searchedNeedle.current === needle) return;
    searchedNeedle.current = needle;
    setOlderPages(0);
    const newest = matches.at(-1);
    if (newest === undefined) setFound(null);
    else reveal(newest);
  }, [needle, matches, reveal]);

  useEffect(() => {
    if (findOpen) return;
    setQuery("");
    setFound(null);
  }, [findOpen]);

  const findOlder = () => {
    const older = position > 0 ? matches[position - 1] : undefined;
    if (older !== undefined) reveal(older);
    else if (needle && chat.hasOlder && !olderPages) {
      setOlderPages(1);
      chat.loadOlder();
    }
  };
  const findNewer = () => {
    const newer = position >= 0 ? matches[position + 1] : undefined;
    if (newer !== undefined) reveal(newer);
  };

  const continueOlderSearch = (loaded: readonly StreamLayoutItem[]) => {
    const current = loaded.findIndex((item) => item.row.key === found);
    const earlier = matches.filter((index) => current === -1 || index < current).at(-1);
    if (earlier !== undefined) {
      setOlderPages(0);
      reveal(earlier);
    } else if (chat.hasOlder && olderPages < 10) {
      setOlderPages(olderPages + 1);
      chat.loadOlder();
    } else setOlderPages(0);
  };
  const latestOlderSearch = useRef(continueOlderSearch);
  latestOlderSearch.current = continueOlderSearch;

  // Once an older page arrives, go to the closest older match, or look one page further (ten at most).
  useEffect(() => {
    if (!olderPages || chat.loadingOlder) return;
    latestOlderSearch.current(items);
  }, [olderPages, chat.loadingOlder, items]);

  return { query, setQuery, found, olderPages, position, total: matches.length, findOlder, findNewer };
}

// A bot that reads its replies aloud reads each one as it finishes, while its chat is open.
function useReadRepliesAloud(running: boolean, voice: BotVoice | undefined, latestCopy: string) {
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running && voice?.readReplies && latestCopy)
      speak(latestCopy, latestCopy, voice.name);
    wasRunning.current = running;
  }, [running, voice, latestCopy]);
  useEffect(() => () => stopSpeaking(), []);
}

interface StreamAuxiliaryProps {
  colors: Colors;
  chat: ChatState;
  running: boolean;
  footer: StreamLayout["auxiliaryFooter"];
  voiceName: RowContext["voice"];
  api: PaseoApi | null;
  agentId: string | null;
  compact: boolean;
  botId?: string;
}

function StreamAuxiliary({
  colors,
  chat,
  running,
  footer,
  voiceName,
  api,
  agentId,
  compact,
  botId,
}: StreamAuxiliaryProps) {
  const permissions = chat.agent?.pendingPermissions ?? [];
  return (
    <View>
      {running ? (
        <WorkingIndicator colors={colors} startedAt={chat.agent?.activeTurn?.startedAt} />
      ) : footer ? (
        <CompletedTurnFooter colors={colors} footer={footer} voice={voiceName} />
      ) : null}
      {permissions.length > 0 ? (
        <View
          style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH, alignSelf: "center", paddingHorizontal: 8 }}
        >
          <View style={{ gap: 12 }}>
            <View style={{ gap: 8 }}>
              {permissions.map((permission) => (
                <PermissionCard
                  key={permission.id}
                  colors={colors}
                  permission={permission}
                  api={api}
                  agentId={agentId}
                  compact={compact}
                  botId={botId}
                  cwd={chat.agent?.cwd}
                />
              ))}
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

function OlderSpinner({ colors }: { colors: Colors }) {
  return (
    <View style={{ paddingVertical: 12, alignItems: "center" }}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} />
    </View>
  );
}

function LoadingOverlay({ colors }: { colors: Colors }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: colors.surface0,
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
    >
      <ActivityIndicator size="large" color={colors.foregroundMuted} />
    </View>
  );
}

interface StreamListProps {
  list: ListRef;
  data: StreamLayoutItem[];
  typeVersion: number;
  inverted: boolean;
  compact: boolean;
  platform: ChatStreamProps["platform"];
  renderItem: (info: ListRenderItemInfo<StreamLayoutItem>) => ReactElement;
  auxiliary: ReactElement;
  olderSpinner: ReactElement | null;
  scroll: StreamScrollHandlers;
}

function StreamList({
  list,
  data,
  typeVersion,
  inverted,
  compact,
  platform,
  renderItem,
  auxiliary,
  olderSpinner,
  scroll,
}: StreamListProps) {
  const ios = platform === "ios";
  return (
    <FlatList
      ref={list}
      data={data}
      extraData={typeVersion}
      inverted={inverted}
      keyExtractor={(item) => item.row.key}
      renderItem={renderItem}
      ListHeaderComponent={inverted ? auxiliary : olderSpinner}
      ListFooterComponent={inverted ? olderSpinner : auxiliary}
      style={{ flex: 1 }}
      contentContainerStyle={{
        flexGrow: 1,
        paddingHorizontal: compact ? 12 : 16,
        ...(inverted ? { paddingVertical: 0 } : { paddingTop: 16, paddingBottom: 16 }),
      }}
      onScroll={scroll.onScroll}
      scrollEventThrottle={16}
      onContentSizeChange={scroll.onContentSizeChange}
      onLayout={scroll.onLayout}
      maintainVisibleContentPosition={
        ios ? { minIndexForVisible: 0, autoscrollToTopThreshold: 0 } : undefined
      }
      initialNumToRender={12}
      windowSize={10}
      removeClippedSubviews={false}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        // Rows outside the rendered window: jump near it, then land on it once it renders.
        list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
        setTimeout(() => list.current?.scrollToIndex({ index, animated: true, viewPosition: 0.3 }), 100);
      }}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode={ios ? "interactive" : "on-drag"}
      showsVerticalScrollIndicator
    />
  );
}

export function ChatStream({
  colors,
  chat,
  api,
  agentId,
  compact,
  platform,
  typeVersion,
  onOpenChat,
  botId,
  voice,
  findOpen = false,
  onCloseFind,
}: ChatStreamProps) {
  const running = isTurnRunning(chat);
  const inverted = platform !== "web";
  const list = useRef<NativeFlatList<StreamLayoutItem>>(null);
  const layout = useStreamLayout(chat, running);
  const data = useMemo(
    () => (inverted ? [...layout.items].reverse() : layout.items),
    [layout.items, inverted],
  );
  const cwd = chat.agent?.cwd;
  const scroll = useStreamScroll({ list, inverted, chat, items: layout.items });
  const find = useStreamFind({ list, items: layout.items, inverted, findOpen, chat });
  const found = find.found;

  const context = useMemo<RowContext>(
    () => ({
      colors,
      compact,
      cwd: cwd ?? undefined,
      attachmentsFor: (row) => {
        const attachments = sentAttachments(row);
        return attachments.length > 0 ? attachments : EMPTY_ATTACHMENTS;
      },
      openChat: onOpenChat,
      agentId,
      botId: botId ?? null,
      voice: canSpeak && voice ? voice.name : undefined,
      highlightKey: findOpen ? found : null,
    }),
    [colors, compact, cwd, onOpenChat, agentId, botId, voice, findOpen, found],
  );

  useReadRepliesAloud(running, voice, layout.auxiliaryFooter?.copy ?? "");

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<StreamLayoutItem>) => (
      <StreamItem item={item} context={context} typeVersion={typeVersion} />
    ),
    [context, typeVersion],
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.surface0 }}>
      {findOpen ? (
        <FindBar
          colors={colors}
          query={find.query}
          position={find.position + 1}
          total={find.total}
          busy={find.olderPages > 0}
          onQuery={find.setQuery}
          onOlder={find.findOlder}
          onNewer={find.findNewer}
          onClose={() => onCloseFind?.()}
        />
      ) : null}
      <StreamList
        list={list}
        data={data}
        typeVersion={typeVersion}
        inverted={inverted}
        compact={compact}
        platform={platform}
        renderItem={renderItem}
        auxiliary={
          <StreamAuxiliary
            colors={colors}
            chat={chat}
            running={running}
            footer={layout.auxiliaryFooter}
            voiceName={context.voice}
            api={api}
            agentId={agentId}
            compact={compact}
            botId={botId}
          />
        }
        olderSpinner={chat.loadingOlder ? <OlderSpinner colors={colors} /> : null}
        scroll={scroll}
      />
      <ScrollToBottomButton
        colors={colors}
        visible={!scroll.nearBottom && data.length > 0}
        onPress={() => scroll.scrollToBottom(true)}
      />
      {chat.error && !chat.loading ? (
        <SyncErrorCallout colors={colors} retrying={chat.retrying} onRetry={chat.retry} />
      ) : null}
      {chat.agent?.archivedAt ? <ArchivedCallout colors={colors} compact={compact} /> : null}
      {chat.loading ? <LoadingOverlay colors={colors} /> : null}
    </View>
  );
}

/** A row renders again only when its layout item (or the type scale) changes. */
const StreamItem = memo(function StreamItem({
  item,
  context,
  typeVersion,
}: {
  item: StreamLayoutItem;
  context: RowContext;
  typeVersion: number;
}) {
  return (
    <>
      {/* Rows read Paseo's font sizes while rendering; a size change remounts them. */}
      <RowFrame
        key={typeVersion}
        gapBelow={item.gapBelow}
        highlight={context.highlightKey === item.row.key ? context.colors.surface2 : undefined}
      >
        <RowContent row={item.row} context={context} compactBottom={item.compactBottom} />
      </RowFrame>
      {item.footer ? (
        <CompletedTurnFooter colors={context.colors} footer={item.footer} voice={context.voice} />
      ) : null}
    </>
  );
});

function useFadeIn(visible: boolean) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    const target = visible ? 1 : 0;
    if (visible) setMounted(true);
    if (Platform.OS === "android") {
      opacity.setValue(target);
      if (!visible) setMounted(false);
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: target,
      duration: 200,
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start(({ finished }) => finished && !visible && setMounted(false));
    return () => animation.stop();
  }, [visible, opacity]);
  return { opacity, mounted };
}

/** view.tsx scroll-to-bottom: 48 round surface2 button with ChevronDown 24, fading in and out. */
function ScrollToBottomButton({
  colors,
  visible,
  onPress,
}: {
  colors: Colors;
  visible: boolean;
  onPress(): void;
}) {
  const { opacity, mounted } = useFadeIn(visible);
  if (!mounted) return null;
  const tokens = nativeTokens(colors);
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 16, alignItems: "center" }}
    >
      <Animated.View style={{ opacity }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scroll to bottom"
          {...tooltip("Scroll to bottom")}
          onPress={onPress}
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: colors.surface2,
            alignItems: "center",
            justifyContent: "center",
            shadowColor: tokens.dark ? "rgba(0, 0, 0, 0.25)" : "rgba(0, 0, 0, 0.02)",
            shadowOffset: { width: 0, height: 2 },
            shadowRadius: tokens.dark ? 4 : 8,
            shadowOpacity: 1,
            elevation: 2,
          }}
        >
          <Icon name="ChevronDown" size={24} color={colors.foreground} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/** agent-panel.tsx TimelineSyncErrorCallout. */
function SyncErrorCallout({
  colors,
  retrying,
  onRetry,
}: {
  colors: Colors;
  retrying: boolean;
  onRetry(): void;
}) {
  return (
    <View style={{ width: "100%", alignItems: "center", paddingHorizontal: 16, paddingTop: 8 }}>
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.statusDanger,
            borderRadius: 16,
            paddingVertical: 8,
            paddingHorizontal: 16,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>
            Couldn't refresh agent history.
          </Text>
          <SecondaryButton
            colors={colors}
            label={retrying ? "Retrying…" : "Retry"}
            disabled={retrying}
            onPress={onRetry}
          />
        </View>
      </View>
    </View>
  );
}

/**
 * archived-agent-callout.tsx. Paseo pairs it with an Unarchive button; the
 * plugin API can't unarchive an agent, so the callout only says so.
 */
function ArchivedCallout({ colors, compact }: { colors: Colors; compact: boolean }) {
  return (
    <View style={{ width: "100%", alignItems: "center", paddingHorizontal: 16, paddingTop: 16 }}>
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: nativeTokens(colors).borderAccent,
            borderRadius: 16,
            paddingVertical: compact ? 12 : 16,
            paddingHorizontal: compact ? 16 : 24,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>This agent is archived</Text>
        </View>
      </View>
    </View>
  );
}

export type { StreamRow };
