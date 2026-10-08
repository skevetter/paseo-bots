import { type Dispatch, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { mergeEntries } from "./chat/stream/model";
import type { PaseoAgent, PaseoApi } from "./paseo";

type AgentHandle = ReturnType<PaseoApi["agents"]["ref"]>;
type TimelinePage = Awaited<ReturnType<AgentHandle["timeline"]["refetch"]>>;
export type ChatEntry = TimelinePage["entries"][number];
type Cursor = NonNullable<TimelinePage["endCursor"]>;

export interface ChatState {
  entries: ChatEntry[];
  agent: PaseoAgent | null;
  loading: boolean;
  error: string | null;
  hasOlder: boolean;
  loadingOlder: boolean;
  retrying: boolean;
  loadOlder(): void;
  retry(): void;
}

/** Paseo's TIMELINE_FETCH_PAGE_SIZE. */
const TIMELINE_PAGE_SIZE = 40;

/** Oldest first. */
export async function fullTimeline(api: PaseoApi, agentId: string): Promise<ChatEntry[]> {
  const handle = api.agents.ref(agentId);
  let page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 200 });
  if (page.error) throw new Error(page.error);
  let entries = page.entries;
  for (let pages = 0; pages < 100 && page.hasOlder && page.startCursor; pages++) {
    page = await handle.timeline.refetch({
      direction: "before",
      cursor: page.startCursor,
      projection: "projected",
      limit: 200,
    });
    if (page.error) throw new Error(page.error);
    if (page.entries.length === 0) break;
    entries = mergeEntries(entries, page.entries);
  }
  return entries;
}

const noop = () => {};
const EMPTY: ChatState = {
  entries: [],
  agent: null,
  loading: false,
  error: null,
  hasOlder: false,
  loadingOlder: false,
  retrying: false,
  loadOlder: noop,
  retry: noop,
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type SyncMode = "tail" | "after";

class ChatTimelineSync {
  private readonly handle: AgentHandle;
  private readonly setState: Dispatch<SetStateAction<ChatState>>;
  private disposed = false;
  private endCursor: Cursor | null = null;
  private startCursor: Cursor | null = null;
  private busy = false;
  private queued: SyncMode | null = null;
  private olderBusy = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private unsubscribers: Array<() => void> = [];

  constructor(handle: AgentHandle, setState: Dispatch<SetStateAction<ChatState>>) {
    this.handle = handle;
    this.setState = setState;
  }

  start(): void {
    const timeline = this.handle.timeline.subscribe((event) => {
      const kind = (event as { event?: { type?: string } }).event?.type;
      if (kind === "replacement") void this.sync("tail");
      else this.schedule();
    });
    void this.sync("tail");
    const unsubscribeAgent = this.handle.subscribe(() => {
      const snapshot = this.handle.current();
      if (snapshot && !this.disposed) this.setState((current) => ({ ...current, agent: snapshot }));
    });
    this.unsubscribers = [timeline, unsubscribeAgent];
    void this.handle
      .refresh()
      .then((result) => {
        if (result && !this.disposed) this.setState((current) => ({ ...current, agent: result.agent }));
      })
      .catch(() => {});
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
  }

  retry(): void {
    this.setState((current) => ({ ...current, retrying: true }));
    void this.sync(this.endCursor ? "after" : "tail");
  }

  loadOlder(): void {
    const cursor = this.startCursor;
    if (this.olderBusy || !cursor || this.disposed) return;
    this.olderBusy = true;
    this.setState((current) => (current.hasOlder ? { ...current, loadingOlder: true } : current));
    void this.handle.timeline
      .refetch({
        direction: "before",
        cursor,
        projection: "projected",
        limit: TIMELINE_PAGE_SIZE,
      })
      .then((page) => this.applyOlderPage(page))
      .catch((error: unknown) => {
        if (!this.disposed)
          this.setState((current) => ({ ...current, loadingOlder: false, error: message(error) }));
      })
      .finally(() => {
        this.olderBusy = false;
      });
  }

  private applyOlderPage(page: TimelinePage): void {
    if (this.disposed) return;
    if (page.error) throw new Error(page.error);
    if (page.staleCursor || page.reset) {
      this.setState((current) => ({ ...current, loadingOlder: false }));
      void this.sync("tail");
      return;
    }
    if (page.startCursor) this.startCursor = page.startCursor;
    this.setState((current) => ({
      ...current,
      entries: mergeEntries(current.entries, page.entries),
      hasOlder: page.hasOlder && page.entries.length > 0,
      loadingOlder: false,
    }));
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.sync("after");
    }, 80);
  }

  private async sync(mode: SyncMode): Promise<void> {
    if (this.busy) {
      if (this.queued !== "tail") this.queued = mode;
      return;
    }
    this.busy = true;
    try {
      await this.syncPages(mode === "tail");
    } catch (error) {
      if (!this.disposed)
        this.setState((current) => ({ ...current, loading: false, retrying: false, error: message(error) }));
    } finally {
      this.busy = false;
      this.runQueued();
    }
  }

  private runQueued(): void {
    if (!this.queued || this.disposed) return;
    const next = this.queued;
    this.queued = null;
    void this.sync(next);
  }

  private async syncPages(tail: boolean): Promise<void> {
    let replace = tail;
    for (let pages = 0; pages < 25 && !this.disposed; pages++) {
      const more = await this.syncPage(replace ? null : this.endCursor);
      if (!more) break;
      replace = false;
    }
  }

  private async syncPage(cursor: Cursor | null): Promise<boolean> {
    const page = await this.fetchPage(cursor);
    if (this.disposed) return false;
    if (page.error) throw new Error(page.error);
    this.applyPage(page, cursor === null);
    return page.hasNewer && page.entries.length > 0;
  }

  private fetchPage(after: Cursor | null): Promise<TimelinePage> {
    if (after === null) {
      return this.handle.timeline.refetch({
        direction: "tail",
        projection: "projected",
        limit: TIMELINE_PAGE_SIZE,
      });
    }
    return this.handle.timeline.refetch({
      direction: "after",
      cursor: after,
      projection: "projected",
      limit: TIMELINE_PAGE_SIZE,
    });
  }

  private applyPage(page: TimelinePage, replace: boolean): void {
    // A new epoch or a gap means our cursor no longer lines up: the page is a fresh tail.
    const reset = replace || page.reset || page.staleCursor || page.gap;
    if (page.endCursor) this.endCursor = page.endCursor;
    if (reset) {
      this.startCursor = page.startCursor;
    }
    this.setState((current) => ({
      ...current,
      entries: reset ? page.entries : mergeEntries(current.entries, page.entries),
      agent: (page.agent as PaseoAgent | null) ?? this.handle.current() ?? current.agent,
      loading: false,
      error: null,
      retrying: false,
      hasOlder: reset ? page.hasOlder : current.hasOlder,
    }));
  }
}

/**
 * Like Paseo's timeline sync: the tail once, then pages after the end cursor on each live
 * event, merged by each projected entry's first seq.
 */
export function useChat(api: PaseoApi | null, agentId: string | null): ChatState {
  const [state, setState] = useState<ChatState>(EMPTY);
  const actions = useRef<{ loadOlder(): void; retry(): void }>({ loadOlder: noop, retry: noop });

  useEffect(() => {
    if (!api || !agentId) {
      setState(EMPTY);
      actions.current = { loadOlder: noop, retry: noop };
      return;
    }
    setState({ ...EMPTY, loading: true });
    const sync = new ChatTimelineSync(api.agents.ref(agentId), setState);
    actions.current = { loadOlder: () => sync.loadOlder(), retry: () => sync.retry() };
    sync.start();
    return () => sync.dispose();
  }, [api, agentId]);

  const loadOlder = useCallback(() => actions.current.loadOlder(), []);
  const retry = useCallback(() => actions.current.retry(), []);
  return { ...state, loadOlder, retry };
}
