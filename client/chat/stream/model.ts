// Mirrors Paseo's agent-stream layout. No React or React Native here, so it's unit tested.

import { ROUTINE_RUN_CARD, type RoutineRunCard, RoutineRunCardSchema } from "../../../shared/rpc";
import { toolCallName } from "../../../shared/tool-name";
import {
  deriveTaskActivities,
  extractTaskEntriesFromToolCall,
  isHiddenTaskTool,
  isHiddenToolCall,
  type TaskActivity,
  type TaskEntry,
  type ToolCallDetail,
  type ToolCallStatus,
  taskStatus,
} from "../../../shared/tools";
import { PLUGIN_ID } from "../../../shared/version";

export interface StreamEntry {
  provider: string;
  item: { type: string; [key: string]: unknown };
  turnId?: string;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
}

interface RowBase {
  /** Stable across streaming: the entry's first seq, or the tool call id. */
  key: string;
  turnId?: string;
  timestamp: number;
}

export type StreamRow =
  | (RowBase & { kind: "user"; text: string; messageId?: string; clientMessageId?: string })
  | (RowBase & { kind: "assistant"; text: string; phase: "streaming" | "complete" })
  | (RowBase & { kind: "thought"; text: string; loading: boolean })
  | (RowBase & {
      kind: "tool";
      name: string;
      status: ToolCallStatus;
      error: unknown;
      detail: ToolCallDetail;
      metadata?: Record<string, unknown>;
    })
  | (RowBase & { kind: "speak"; text: string })
  | (RowBase & { kind: "todo"; items: TaskEntry[]; activity: TaskActivity })
  | (RowBase & { kind: "notification"; level: "info" | "warning" | "error"; message: string })
  | (RowBase & {
      kind: "compaction";
      status: "loading" | "completed";
      trigger?: "auto" | "manual";
      preTokens?: number;
    })
  | (RowBase & { kind: "routine-run"; card: RoutineRunCard });

export interface TurnFooterInfo {
  /** Key of the assistant row the footer belongs to. */
  key: string;
  copy: string;
  completedAt: number | null;
  durationMs: number | null;
}

export interface StreamLayoutItem {
  row: StreamRow;
  gapBelow: number;
  /** Assistant rows drop their bottom padding when a footer follows. */
  compactBottom: boolean;
  footer: TurnFooterInfo | null;
}

export interface StreamLayout {
  items: StreamLayoutItem[];
  /** Footer of the latest response, rendered after the list when no turn is running. */
  auxiliaryFooter: TurnFooterInfo | null;
}

const EMPTY: never[] = [];

function toTime(timestamp: string): number {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : 0;
}

function toolStatus(value: unknown): ToolCallStatus {
  return value === "running" || value === "failed" || value === "canceled" ? value : "completed";
}

type TodoRow = Extract<StreamRow, { kind: "todo" }>;
type StreamItem = StreamEntry["item"];

interface RowBuilder {
  rows: StreamRow[];
  lastTodo: TodoRow | null;
}

function extendsCreatedTodo(
  tail: StreamRow | undefined,
  activities: readonly TaskActivity[],
  items: readonly TaskEntry[],
): tail is TodoRow {
  return (
    activities.length === 1 &&
    activities[0]?.type === "added" &&
    tail?.kind === "todo" &&
    tail.activity.type === "created" &&
    items.every((task) => taskStatus(task) === "pending")
  );
}

function appendTodo(builder: RowBuilder, entry: StreamEntry, items: TaskEntry[]): void {
  const timestamp = toTime(entry.timestamp);
  const activities = deriveTaskActivities(builder.lastTodo?.items ?? EMPTY, items);
  if (activities.length === 0) {
    if (builder.lastTodo) {
      builder.lastTodo.items = items;
      builder.lastTodo.timestamp = timestamp;
    }
    return;
  }
  const tail = builder.rows.at(-1);
  if (extendsCreatedTodo(tail, activities, items)) {
    tail.items = items;
    tail.activity = { type: "created", count: items.length };
    tail.timestamp = timestamp;
    builder.lastTodo = tail;
    return;
  }
  for (const [index, activity] of activities.entries()) {
    const row: TodoRow = {
      key: `${entry.seqStart}:todo:${index}`,
      kind: "todo",
      turnId: entry.turnId,
      timestamp,
      items,
      activity,
    };
    builder.rows.push(row);
    builder.lastTodo = row;
  }
}

function speakText(name: string, detail: ToolCallDetail): string | null {
  if (name !== "speak" || detail.type !== "unknown") return null;
  return typeof detail.input === "string" && detail.input.trim() ? detail.input : null;
}

interface ToolCall {
  name: string;
  status: ToolCallStatus;
  detail: ToolCallDetail;
}

function toolCallRow(base: RowBase, item: StreamItem, { name, status, detail }: ToolCall): StreamRow {
  const key = typeof item.callId === "string" && item.callId ? `tool:${item.callId}` : base.key;
  const text = speakText(name, detail);
  if (text !== null) return { ...base, key, kind: "speak", text };
  return {
    ...base,
    key,
    kind: "tool",
    name,
    status,
    error: item.error ?? null,
    detail,
    ...(item.metadata && typeof item.metadata === "object"
      ? { metadata: item.metadata as Record<string, unknown> }
      : {}),
  };
}

/** What one entry adds: a row, task entries to fold into the task rows, or nothing. */
type EntryRows = StreamRow | TaskEntry[] | null;

function toolCallRows(entry: StreamEntry, base: RowBase): EntryRows {
  const item = entry.item;
  const name = toolCallName({ name: String(item.name ?? ""), metadata: item.metadata });
  const status = toolStatus(item.status);
  const detail = (item.detail ?? { type: "unknown", input: null, output: null }) as ToolCallDetail;
  if (isHiddenToolCall(name, status) || isHiddenTaskTool(name, entry.provider)) return null;
  const tasks = extractTaskEntriesFromToolCall(name, detail.type === "unknown" ? detail.input : null);
  return tasks ?? toolCallRow(base, item, { name, status, detail });
}

function userRow(base: RowBase, item: StreamItem): StreamRow {
  const messageId = typeof item.messageId === "string" ? { messageId: item.messageId } : {};
  const clientMessageId =
    typeof item.clientMessageId === "string" ? { clientMessageId: item.clientMessageId } : {};
  return { ...base, kind: "user", text: String(item.text ?? ""), ...messageId, ...clientMessageId };
}

function compactionRow(base: RowBase, item: StreamItem): StreamRow {
  const trigger: { trigger?: "auto" | "manual" } =
    item.trigger === "auto" || item.trigger === "manual" ? { trigger: item.trigger } : {};
  const preTokens = typeof item.preTokens === "number" ? { preTokens: item.preTokens } : {};
  return {
    ...base,
    kind: "compaction",
    status: item.status === "loading" ? "loading" : "completed",
    ...trigger,
    ...preTokens,
  };
}

function routineRunRow(base: RowBase, entry: StreamEntry): StreamRow | null {
  const item = entry.item;
  // Other plugins' items belong to their renderers.
  if (item.pluginId !== PLUGIN_ID || item.kind !== ROUTINE_RUN_CARD.kind) return null;
  const card = RoutineRunCardSchema.safeParse(item.data);
  if (!card.success) return null;
  return {
    ...base,
    key: `plugin:${String(item.id ?? entry.seqStart)}`,
    kind: "routine-run",
    card: card.data,
  };
}

function entryRow(base: RowBase, entry: StreamEntry, streaming: boolean): StreamRow | null {
  const item = entry.item;
  switch (item.type) {
    case "user_message":
      return userRow(base, item);
    case "assistant_message":
      return {
        ...base,
        kind: "assistant",
        text: String(item.text ?? ""),
        phase: streaming ? "streaming" : "complete",
      };
    case "reasoning":
      return { ...base, kind: "thought", text: String(item.text ?? ""), loading: streaming };
    case "error":
      return { ...base, kind: "notification", level: "error", message: String(item.message ?? "") };
    case "notification": {
      const level = item.level === "warning" || item.level === "error" ? item.level : "info";
      return { ...base, kind: "notification", level, message: String(item.message ?? "") };
    }
    case "compaction":
      return compactionRow(base, item);
    case "plugin":
      return routineRunRow(base, entry);
    default:
      return null;
  }
}

function deriveEntryRows(entry: StreamEntry, streaming: boolean): EntryRows {
  const item = entry.item;
  const base = { key: `e${entry.seqStart}`, turnId: entry.turnId, timestamp: toTime(entry.timestamp) };
  if (item.type === "tool_call") return toolCallRows(entry, base);
  if (item.type === "todo") return Array.isArray(item.items) ? (item.items as TaskEntry[]) : [];
  return entryRow(base, entry, streaming);
}

/**
 * A re-sent entry is a new object, so an entry's rows can be reused: unchanged rows keep their
 * identity and retainLayout needn't compare them. Rows from here must never be mutated.
 */
const entryRowsCache = new WeakMap<StreamEntry, EntryRows>();

function entryRows(entry: StreamEntry, streaming: boolean): EntryRows {
  if (streaming) return deriveEntryRows(entry, true);
  let rows = entryRowsCache.get(entry);
  if (rows === undefined) {
    rows = deriveEntryRows(entry, false);
    entryRowsCache.set(entry, rows);
  }
  return rows;
}

function appendEntry(builder: RowBuilder, entry: StreamEntry, streaming: boolean): void {
  const rows = entryRows(entry, streaming);
  if (Array.isArray(rows)) appendTodo(builder, entry, rows);
  else if (rows) builder.rows.push(rows);
}

// FlatList keys must be unique even if a provider reuses a call id.
function makeKeysUnique(rows: StreamRow[]): void {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    let key = row.key;
    for (let n = 1; seen.has(key); n++) key = `${row.key}#${n}`;
    if (key !== row.key) rows[index] = { ...row, key };
    seen.add(key);
  }
}

export function buildRows(entries: readonly StreamEntry[], running: boolean): StreamRow[] {
  const builder: RowBuilder = { rows: [], lastTodo: null };
  for (const [index, entry] of entries.entries()) {
    appendEntry(builder, entry, running && index === entries.length - 1);
  }
  makeKeysUnique(builder.rows);
  return builder.rows;
}

type Category = "user" | "assistant" | "tool" | "other";

function category(row: StreamRow | null | undefined): Category | null {
  if (!row) return null;
  switch (row.kind) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "tool":
    case "thought":
    case "todo":
    case "speak":
      return "tool";
    default:
      return "other";
  }
}

/** Routine result cards arrive between turns and belong to none. */
const standsAlone = (row: StreamRow) => row.kind === "routine-run";

function continuesTurn(previous: StreamRow | null, next: StreamRow | null): boolean {
  if (!previous || !next || standsAlone(previous) || standsAlone(next)) return false;
  if (previous.turnId !== undefined && next.turnId !== undefined) return previous.turnId === next.turnId;
  return next.kind !== "user";
}

function continuesResponse(previous: StreamRow | null, next: StreamRow | null): boolean {
  if (!previous || !next || standsAlone(previous) || standsAlone(next)) return false;
  return continuesTurn(previous, next) || next.kind !== "user";
}

function isResponseBoundary(previous: StreamRow | null, next: StreamRow | null): boolean {
  return previous !== null && next !== null && !continuesResponse(previous, next);
}

/** Gap below a row of the outer category when a row of the inner one follows; 16 otherwise. */
const GAPS: Record<Category, Partial<Record<Category, number>>> = {
  user: { user: 4, assistant: 0, tool: 16 },
  assistant: { tool: 4 },
  tool: { tool: 0, assistant: 4 },
  other: {},
};

export function gapBetween(row: StreamRow | null, below: StreamRow | null): number {
  const a = category(row);
  const b = category(below);
  if (!a || !b) return 0;
  return GAPS[a][b] ?? 16;
}

interface TurnTiming {
  completedAt: number;
  durationMs: number | null;
}

export function deriveTurnTiming(rows: readonly StreamRow[], running: boolean): Map<string, TurnTiming> {
  const timing = new Map<string, TurnTiming>();
  let userAt: number | null = null;
  let lastAt: number | null = null;
  let assistants: string[] = [];
  let previous: StreamRow | null = null;
  const flush = () => {
    if (lastAt === null || assistants.length === 0) return;
    const value = { completedAt: lastAt, durationMs: userAt !== null ? Math.max(0, lastAt - userAt) : null };
    for (const key of assistants) timing.set(key, value);
  };
  for (const row of rows) {
    if (previous === null || !continuesTurn(previous, row)) {
      flush();
      userAt = row.kind === "user" ? row.timestamp : null;
      lastAt = null;
      assistants = [];
    }
    lastAt = row.timestamp;
    if (row.kind === "assistant") assistants.push(row.key);
    previous = row;
  }
  if (!running) flush();
  return timing;
}

interface AssistantAt {
  index: number;
  key: string;
}

function latestAssistantInResponse(rows: readonly StreamRow[], index: number): AssistantAt | null {
  let later: StreamRow | null = null;
  for (let i = index; i >= 0; i--) {
    const row = rows[i];
    if (!row || (later && !continuesResponse(row, later))) return null;
    if (row.kind === "assistant") return { index: i, key: row.key };
    later = row;
  }
  return null;
}

function responseText(rows: readonly StreamRow[], index: number): string {
  const messages: string[] = [];
  let later: StreamRow | null = null;
  for (let i = index; i >= 0; i--) {
    const row = rows[i];
    if (!row || (later && !continuesResponse(row, later))) break;
    if (row.kind === "assistant") messages.push(row.text);
    later = row;
  }
  return messages.reverse().join("\n\n");
}

function footerFor(
  rows: readonly StreamRow[],
  assistant: AssistantAt,
  timing: Map<string, TurnTiming>,
): TurnFooterInfo {
  const time = timing.get(assistant.key);
  return {
    key: assistant.key,
    copy: responseText(rows, assistant.index),
    completedAt: time?.completedAt ?? null,
    durationMs: time?.durationMs ?? null,
  };
}

function latestResponseFooter(
  rows: readonly StreamRow[],
  timing: Map<string, TurnTiming>,
): TurnFooterInfo | null {
  if (rows.length === 0) return null;
  const assistant = latestAssistantInResponse(rows, rows.length - 1);
  return assistant ? footerFor(rows, assistant, timing) : null;
}

interface FooterContext {
  rows: readonly StreamRow[];
  timing: Map<string, TurnTiming>;
  auxiliaryKey: string | undefined;
}

function boundaryFooter(context: FooterContext, row: StreamRow, index: number): TurnFooterInfo | null {
  const below = context.rows[index + 1] ?? null;
  if (row.kind === "user" || !isResponseBoundary(row, below)) return null;
  const assistant = latestAssistantInResponse(context.rows, index);
  if (assistant === null || assistant.key === context.auxiliaryKey) return null;
  return footerFor(context.rows, assistant, context.timing);
}

/** For a forward (oldest-first) list. */
export function layoutStream(rows: readonly StreamRow[], running: boolean): StreamLayout {
  const timing = deriveTurnTiming(rows, running);
  const auxiliaryFooter = running ? null : latestResponseFooter(rows, timing);
  const hasAuxiliaryFooter = running || auxiliaryFooter !== null;
  const context: FooterContext = { rows, timing, auxiliaryKey: auxiliaryFooter?.key };
  const items = rows.map((row, index): StreamLayoutItem => {
    const below = rows[index + 1] ?? null;
    const footer = boundaryFooter(context, row, index);
    const compactBottom =
      row.kind === "assistant" && (footer !== null || (hasAuxiliaryFooter && below === null));
    return { row, gapBelow: footer ? 0 : gapBetween(row, below), compactBottom, footer };
  });
  return { items, auxiliaryFooter };
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

/** Arrays by content; plain objects, such as a todo row's activity, by their own fields. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return isPlainObject(a) && isPlainObject(b) && shallowEqual(a, b, (x, y) => x === y);
}

function shallowEqual(a: object, b: object, same: (a: unknown, b: unknown) => boolean = sameValue): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => same(left[key], right[key]));
}

function sameFooter(a: TurnFooterInfo | null, b: TurnFooterInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.key === b.key && a.copy === b.copy && a.completedAt === b.completedAt && a.durationMs === b.durationMs
  );
}

function retainItem(old: StreamLayoutItem, item: StreamLayoutItem): StreamLayoutItem {
  const row =
    old.row === item.row || (old.row.kind === item.row.kind && shallowEqual(old.row, item.row))
      ? old.row
      : item.row;
  const same =
    row === old.row &&
    old.gapBelow === item.gapBelow &&
    old.compactBottom === item.compactBottom &&
    sameFooter(old.footer, item.footer);
  return same ? old : { ...item, row };
}

/** Reuses unchanged rows and items so memoised rows skip rendering while another row streams. */
export function retainLayout(previous: StreamLayout | null, next: StreamLayout): StreamLayout {
  if (!previous) return next;
  let byKey: Map<string, StreamLayoutItem> | null = null;
  // Rows only move when older history loads, so the item at the same index is nearly always the match.
  const oldItem = (key: string, index: number) => {
    const aligned = previous.items[index];
    if (aligned?.row.key === key) return aligned;
    byKey ??= new Map(previous.items.map((item) => [item.row.key, item]));
    return byKey.get(key);
  };
  let changed = previous.items.length !== next.items.length;
  const items = next.items.map((item, index) => {
    const old = oldItem(item.row.key, index);
    const kept = old ? retainItem(old, item) : item;
    if (kept !== previous.items[index]) changed = true;
    return kept;
  });
  const auxiliaryFooter = sameFooter(previous.auxiliaryFooter, next.auxiliaryFooter)
    ? previous.auxiliaryFooter
    : next.auxiliaryFooter;
  if (!changed && auxiliaryFooter === previous.auxiliaryFooter) return previous;
  return { items: changed ? items : previous.items, auxiliaryFooter };
}

export interface MergeableEntry {
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges?: readonly { startSeq: number; endSeq: number }[];
}

function sameEntry(a: MergeableEntry, b: MergeableEntry): boolean {
  if (a.seqStart !== b.seqStart || a.seqEnd !== b.seqEnd) return false;
  return JSON.stringify(a.sourceSeqRanges ?? null) === JSON.stringify(b.sourceSeqRanges ?? null);
}

/** `needle` must already be lower-case. */
export function findRows(items: readonly StreamLayoutItem[], needle: string): number[] {
  if (!needle) return [];
  return items.flatMap((item, index) => {
    const row = item.row;
    const text = row.kind === "user" || row.kind === "assistant" || row.kind === "speak" ? row.text : "";
    return text.toLowerCase().includes(needle) ? [index] : [];
  });
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
