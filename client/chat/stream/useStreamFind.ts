import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChatState } from "../../useChat";
import { findRows, type StreamLayoutItem } from "./model";
import type { ListRef } from "./useStreamScroll";

interface StreamFindOptions {
  list: ListRef;
  items: readonly StreamLayoutItem[];
  inverted: boolean;
  findOpen: boolean;
  chat: ChatState;
}

export function useStreamFind({ list, items, inverted, findOpen, chat }: StreamFindOptions) {
  const [query, setQuery] = useState("");
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

  useEffect(() => {
    if (!olderPages || chat.loadingOlder) return;
    latestOlderSearch.current(items);
  }, [olderPages, chat.loadingOlder, items]);

  return { query, setQuery, found, olderPages, position, total: matches.length, findOlder, findNewer };
}
