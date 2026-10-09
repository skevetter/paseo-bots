import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import type {
  LayoutChangeEvent,
  FlatList as NativeFlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from "react-native";
import type { ChatState } from "../../useChat";
import type { StreamLayoutItem } from "./model";

const WEB_NEAR_BOTTOM = 64;
const NATIVE_NEAR_BOTTOM = 32;
const HISTORY_START_THRESHOLD = 96;

export type ListRef = RefObject<NativeFlatList<StreamLayoutItem> | null>;

interface StreamScrollOptions {
  list: ListRef;
  inverted: boolean;
  chat: ChatState;
  items: readonly StreamLayoutItem[];
}

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

export interface StreamScrollHandlers {
  onScroll(event: NativeSyntheticEvent<NativeScrollEvent>): void;
  onContentSizeChange(width: number, height: number): void;
  onLayout(event: LayoutChangeEvent): void;
}

interface StreamScroll extends StreamScrollHandlers {
  nearBottom: boolean;
  scrollToBottom(animated: boolean): void;
}

export function useStreamScroll({ list, inverted, chat, items }: StreamScrollOptions): StreamScroll {
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
