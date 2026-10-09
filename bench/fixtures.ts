import type { StreamEntry } from "../client/chat/stream/model";
import type { Bot, BotGroup, BotListUi } from "../shared/bot";
import { DEFAULT_BOT_LIST_UI } from "../shared/bot";
import { displayTitle } from "../shared/chat";
import { teamTabs } from "../shared/groups";
import { aggregateBuckets, chatBucket, orderChats, SIDEBAR_GROUP_LIMIT } from "../shared/sidebar";
import { makeBot } from "../tests/helpers";

const START = Date.parse("2026-09-01T00:00:00.000Z");

const MARKDOWN = [
  "Here's what I found:",
  "",
  "1. **The scheduler** reads `routines.json` on every tick.",
  "2. The relay keeps its port in `state.json`.",
  "",
  "```ts",
  "export function tick(now: number) {",
  "  return routines.filter((routine) => due(routine, now));",
  "}",
  "```",
  "",
  "| File | Lines |",
  "| --- | --- |",
  "| scheduler.ts | 420 |",
  "| relay.ts | 310 |",
].join("\n");

interface Seq {
  seq: number;
  turn: number;
}

function entryAt(state: Seq, item: StreamEntry["item"]): StreamEntry {
  state.seq += 1;
  return {
    provider: "claude",
    item,
    turnId: `turn-${state.turn}`,
    timestamp: new Date(START + state.seq * 1000).toISOString(),
    seqStart: state.seq,
    seqEnd: state.seq,
  };
}

function todoCall(state: Seq): StreamEntry {
  const done = state.turn % 3;
  const todos = ["Read the code", "Write the fix", "Run the tests"].map((content, index) => ({
    content,
    status: index < done ? "completed" : index === done ? "in_progress" : "pending",
  }));
  return entryAt(state, {
    type: "tool_call",
    callId: `todo-${state.seq + 1}`,
    name: "TodoWrite",
    status: "completed",
    error: null,
    detail: { type: "unknown", input: { todos }, output: null },
  });
}

function toolCall(state: Seq, name: string, detail: Record<string, unknown>): StreamEntry {
  return entryAt(state, {
    type: "tool_call",
    callId: `call-${state.seq + 1}`,
    name,
    status: "completed",
    error: null,
    detail,
  });
}

function turnEntries(state: Seq): StreamEntry[] {
  state.turn += 1;
  const n = state.turn;
  const entries = [
    entryAt(state, { type: "user_message", text: `Can you look at issue #${n} and fix the scheduler?` }),
    entryAt(state, { type: "reasoning", text: "Looking at the scheduler and the relay first." }),
    toolCall(state, "Bash", { type: "shell", command: `rg -n tick server/`, output: "server/a.ts:1:tick" }),
    toolCall(state, "Read", { type: "read", filePath: "server/scheduler.ts", content: MARKDOWN }),
    entryAt(state, { type: "assistant_message", text: `${MARKDOWN}\n\nTurn ${n}.` }),
    toolCall(state, "Edit", {
      type: "edit",
      filePath: "server/scheduler.ts",
      oldString: "a",
      newString: "b",
    }),
  ];
  if (n % 4 === 0) entries.push(todoCall(state));
  entries.push(entryAt(state, { type: "assistant_message", text: `Fixed it in turn ${n}. ${MARKDOWN}` }));
  return entries;
}

/** Oldest first; about `rows` rendered rows. */
export function chatEntries(rows: number): StreamEntry[] {
  const state: Seq = { seq: 0, turn: 0 };
  const entries: StreamEntry[] = [];
  while (entries.length < rows) entries.push(...turnEntries(state));
  return entries;
}

/** The last entry, re-sent with one more streamed chunk. */
export function streamedChunk(entries: readonly StreamEntry[], chunk: string): StreamEntry {
  const last = entries.at(-1);
  if (!last) throw new Error("No entries");
  return {
    ...last,
    item: { ...last.item, text: `${String(last.item.text ?? "")}${chunk}` },
    seqEnd: last.seqEnd + 1,
  };
}

export interface FakeChat {
  id: string;
  title: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  pendingPermissions: unknown[];
  requiresAttention: boolean;
  attentionReason: string | null;
}

export interface SidebarFixture {
  bots: Bot[];
  groups: BotGroup[];
  chats: Map<string, FakeChat[]>;
  ui: BotListUi;
}

function fakeChat(botIndex: number, chatIndex: number): FakeChat {
  const at = (minutes: number) => new Date(START + minutes * 60_000).toISOString();
  return {
    id: `chat-${botIndex}-${chatIndex}`,
    title: chatIndex % 5 === 0 ? "" : `Chat ${chatIndex} about routines`,
    status: chatIndex === 0 ? "running" : chatIndex % 7 === 0 ? "error" : "idle",
    createdAt: at(botIndex * 100 + chatIndex),
    updatedAt: at(botIndex * 100 + ((chatIndex * 37) % 100)),
    pendingPermissions: chatIndex === 3 ? [{}] : [],
    requiresAttention: chatIndex % 4 === 0,
    attentionReason: null,
  };
}

/** 50 bots in 5 teams of 6 plus 20 unteamed; 3 to 25 chats each; 8 pinned chats. */
export function sidebarFixture(): SidebarFixture {
  const bots = Array.from({ length: 50 }, (_, index) =>
    makeBot({ id: `bot-${index}`, name: `Bot ${index}`, pinned: index % 9 === 0 }),
  );
  const groups: BotGroup[] = Array.from({ length: 5 }, (_, team) => ({
    id: `team-${team}`,
    name: `Team ${team}`,
    logo: null,
    leadId: `bot-${team * 6}`,
    memberIds: Array.from({ length: 6 }, (_, member) => `bot-${team * 6 + member}`),
    instructions: "",
    createdAt: new Date(START).toISOString(),
    updatedAt: new Date(START).toISOString(),
  }));
  const chats = new Map(
    bots.map((bot, index) => [
      bot.id,
      Array.from({ length: 3 + (index % 23) }, (_, chat) => fakeChat(index, chat)),
    ]),
  );
  const pinnedChats = Array.from({ length: 8 }, (_, index) => ({
    botId: `bot-${index * 6}`,
    chatId: `chat-${index * 6}-1`,
  }));
  const ui: BotListUi = {
    ...DEFAULT_BOT_LIST_UI,
    pinnedChats,
    collapsed: bots.filter((_, index) => index % 5 === 4).map((bot) => bot.id),
    chatOrder: { "bot-1": ["chat-1-2", "chat-1-0"] },
  };
  return { bots, groups, chats, ui };
}

export interface SidebarRowView {
  key: string;
  title: string;
  bucket: string;
  siblings?: readonly string[];
}

function groupRows(fixture: SidebarFixture, bot: Bot, pinnedIds: ReadonlySet<string>): SidebarRowView[] {
  const { ui } = fixture;
  const isOpen = !ui.collapsed.includes(bot.id);
  const unpinned = (fixture.chats.get(bot.id) ?? []).filter((chat) => !pinnedIds.has(chat.id));
  const ordered = orderChats(unpinned, ui.chatSort, ui.chatOrder[bot.id]);
  const header = {
    key: bot.id,
    title: bot.name,
    bucket: isOpen ? "" : aggregateBuckets(unpinned.map(chatBucket)),
  };
  if (!isOpen) return [header];
  const siblings = ordered.map((chat) => chat.id);
  return [
    header,
    ...ordered.slice(0, SIDEBAR_GROUP_LIMIT).map((chat) => ({
      key: chat.id,
      title: displayTitle(chat.title),
      bucket: chatBucket(chat),
      siblings,
    })),
  ];
}

/** What BotsSurface, BotSidebar, BotGroupSection, BotChatList and the rows compute on one render. */
export function sidebarRender(fixture: SidebarFixture): SidebarRowView[] {
  const { ui } = fixture;
  const listed = fixture.bots
    .filter((bot) => ui.showArchived || !bot.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const tabs = teamTabs(fixture.groups, listed);
  const shown = tabs.find((tab) => tab.id === ui.tab)?.bots ?? listed;
  const pinnedIds = new Set(ui.pinnedChats.map((pin) => pin.chatId));
  const botById = new Map(shown.map((bot) => [bot.id, bot]));
  const rows = ui.pinnedChats.flatMap((pin) => {
    const bot = botById.get(pin.botId);
    const chat = bot && fixture.chats.get(bot.id)?.find((entry) => entry.id === pin.chatId);
    return chat ? [{ key: chat.id, title: displayTitle(chat.title), bucket: chatBucket(chat) }] : [];
  });
  return [...rows, ...shown.flatMap((bot) => groupRows(fixture, bot, pinnedIds))];
}
