import type { Bot, HistoryEntry } from "./bot";

const HISTORY_PER_BOT = 20;
/** Edits closer together than this undo as one step. */
const HISTORY_COALESCE_MS = 60_000;

export function pushHistory(
  history: readonly HistoryEntry[],
  previous: Bot,
  now: Date = new Date(),
): HistoryEntry[] {
  const latest = [...history].reverse().find((entry) => entry.botId === previous.id);
  if (latest && now.getTime() - Date.parse(latest.at) < HISTORY_COALESCE_MS) return [...history];
  const next = [...history, { botId: previous.id, at: now.toISOString(), snapshot: previous }];
  const mine = next.filter((entry) => entry.botId === previous.id);
  const drop = new Set(mine.slice(0, Math.max(0, mine.length - HISTORY_PER_BOT)));
  return next.filter((entry) => !drop.has(entry));
}
