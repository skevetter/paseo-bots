export interface MergeableEntry {
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges?: readonly { startSeq: number; endSeq: number }[];
}

function sameEntry(a: MergeableEntry, b: MergeableEntry): boolean {
  if (a.seqStart !== b.seqStart || a.seqEnd !== b.seqEnd) return false;
  return JSON.stringify(a.sourceSeqRanges ?? null) === JSON.stringify(b.sourceSeqRanges ?? null);
}

/**
 * Keyed by first seq: a re-sent entry (a message still streaming, a tool that finished)
 * replaces the old one; unchanged ones keep their identity.
 */
export function mergeEntries<T extends MergeableEntry>(current: readonly T[], incoming: readonly T[]): T[] {
  if (incoming.length === 0) return current as T[];
  const bySeq = new Map<number, T>();
  for (const entry of current) bySeq.set(entry.seqStart, entry);
  let changed = false;
  for (const entry of incoming) {
    const existing = bySeq.get(entry.seqStart);
    if (existing && sameEntry(existing, entry)) continue;
    bySeq.set(entry.seqStart, entry);
    changed = true;
  }
  if (!changed) return current as T[];
  return [...bySeq.values()].sort((a, b) => a.seqStart - b.seqStart);
}

interface TimelinePage<Entry, Cursor> {
  entries: Entry[];
  error?: string | null;
  hasOlder: boolean;
  startCursor?: Cursor | null;
}

// Shared code may only import the plugin SDK's root, so callers pass their Paseo API in, checked against this.
export interface TimelineApi<Entry, Cursor> {
  readonly agents: {
    ref(agentId: string): {
      readonly timeline: {
        refetch(options: {
          direction: "tail" | "before";
          cursor?: Cursor;
          projection: "projected";
          limit: number;
        }): Promise<TimelinePage<Entry, Cursor>>;
      };
    };
  };
}

/** Oldest first. */
export async function fullTimeline<Entry extends MergeableEntry, Cursor>(
  api: TimelineApi<Entry, Cursor>,
  agentId: string,
): Promise<Entry[]> {
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
