import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useCallback, useEffect, useMemo, useRef } from "react";
import { type ListRenderItemInfo, type FlatList as NativeFlatList, View } from "react-native";
import type { ComposerAttachment } from "../../shared/attachments";
import type { BotVoice } from "../../shared/bot";
import { CONTENT_MAX_WIDTH } from "../native";
import type { PaseoApi } from "../paseo";
import { sentAttachments } from "../sent-attachments";
import { canSpeak, speak, stopSpeaking } from "../speech";
import type { ChatState } from "../useChat";
import { FindBar } from "./FindBar";
import { PermissionCard } from "./Permission";
import {
  buildRows,
  layoutStream,
  retainLayout,
  type StreamEntry,
  type StreamLayout,
  type StreamLayoutItem,
  type StreamRow,
} from "./stream/model";
import {
  ArchivedCallout,
  LoadingOverlay,
  OlderSpinner,
  ScrollToBottomButton,
  SyncErrorCallout,
} from "./stream/overlays";
import type { RowContext } from "./stream/rows";
import { StreamItem } from "./stream/StreamItem";
import { CompletedTurnFooter, WorkingIndicator } from "./stream/TurnFooter";
import { useStreamFind } from "./stream/useStreamFind";
import { type ListRef, type StreamScrollHandlers, useStreamScroll } from "./stream/useStreamScroll";

type Colors = PluginTheme["colors"];

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
  /** Set for bots on this host. */
  botId?: string;
  voice?: BotVoice;
  findOpen?: boolean;
  onCloseFind?(): void;
}

function isTurnRunning(chat: ChatState): boolean {
  return chat.agent?.status === "running" || chat.agent?.status === "initializing";
}

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

export type { StreamRow };
