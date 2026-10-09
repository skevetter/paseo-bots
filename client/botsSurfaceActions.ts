import { copyText } from "@getpaseo/plugin/client/react-native";
import type { LayoutRectangle } from "react-native";
import { randomSeed } from "../shared/avatar";
import {
  applyDefaults,
  type Bot,
  type BotGroup,
  type BotListUi,
  type BotSettingsValues,
  DEFAULT_BOT_DEFAULTS,
  DEFAULT_BOT_LIST_UI,
  EMPTY_LIBRARY,
  type Library,
  newBotId,
  newGroupId,
  type Preset,
  presetFromBot,
} from "../shared/bot";
import { displayTitle } from "../shared/chat";
import { saveTeam, type TeamDraft, type TeamTab, tabOf, teamTabs, withoutBot } from "../shared/groups";
import { fitColumns } from "../shared/layout";
import { addImportedBots } from "../shared/library";
import { moveKey } from "../shared/sidebar";
import { type BotTemplate, botFromPreset, newBot } from "../shared/templates";
import { chatTranscript } from "../shared/transcript";
import { botMenuEntries, chatMenuEntries } from "./BotDialogs";
import type { BotHost } from "./data";
import { confirmDialog, errorText } from "./native";
import type { SectionId } from "./panel/BotPanel";
import type { PaseoAgent } from "./paseo";
import type { ChatMenuRequest, MenuSource, Selection } from "./sidebar/types";
import { measureAnchor } from "./ui/Menu";
import type { BotsSurfaceModel } from "./useBotsSurface";
import { fullTimeline } from "./useChat";

export interface SurfaceView {
  values: BotSettingsValues;
  listUi: BotListUi;
  columns: { list: number; panel: number | null };
  allBots: Bot[];
  library: Library;
  groups: BotGroup[];
  listed: Bot[];
  selectedBot: Bot | undefined;
  archivedCount: number;
  tabs: TeamTab[];
  openTab: TeamTab | null;
}

export interface SurfaceContext extends BotsSurfaceModel, SurfaceView {}

export interface NewBotStart {
  template?: BotTemplate;
  preset?: Preset;
}

export function surfaceContext(model: BotsSurfaceModel, values: BotSettingsValues): SurfaceContext {
  const { dragWidths, panel, selection, drafts } = model;
  const listUi = model.uiOverride ?? values.ui ?? DEFAULT_BOT_LIST_UI;
  const panelWidth = panel.open && selection ? (dragWidths.panel ?? listUi.panelWidth) : null;
  const allBots = values.bots.map((bot) => drafts[bot.id] ?? bot);
  const groups = values.groups ?? [];
  const listed = allBots
    .filter((bot) => listUi.showArchived || !bot.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const tabs = teamTabs(groups, listed);
  return {
    ...model,
    values,
    listUi,
    columns: fitColumns(model.surfaceWidth || 1600, dragWidths.list ?? listUi.listWidth, panelWidth),
    allBots,
    library: values.library ?? EMPTY_LIBRARY,
    groups,
    listed,
    selectedBot: selection ? allBots.find((bot) => bot.id === selection.botId) : undefined,
    archivedCount: allBots.filter((bot) => bot.archived).length,
    tabs,
    openTab: tabs.find((tab) => tab.id === listUi.tab) ?? tabs[0] ?? null,
  };
}

export function select(ctx: SurfaceContext, next: Selection) {
  ctx.setSelection(next);
  ctx.setTeamMap(false);
  const { openTab, groups } = ctx;
  const tab = openTab && tabOf(next.botId, groups) !== openTab.id ? tabOf(next.botId, groups) : null;
  if (tab || ctx.currentUi().collapsed.includes(next.botId)) {
    ctx.updateUi((current) => ({
      ...current,
      tab: tab ?? current.tab,
      collapsed: current.collapsed.filter((id) => id !== next.botId),
    }));
  }
}

function openPanel(ctx: SurfaceContext, bot: Bot, section: SectionId | null) {
  if (ctx.selection?.botId !== bot.id) select(ctx, { botId: bot.id, chatId: null });
  ctx.setPanel({ open: true, section });
}

async function addBot(ctx: SurfaceContext, bot: Bot, section: SectionId = "identity") {
  const saved = await ctx.commit((values) => ({ ...values, bots: [...values.bots, bot] }));
  if (saved) {
    select(ctx, { botId: bot.id, chatId: null });
    ctx.setPanel({ open: true, section });
  }
}

async function duplicate(ctx: SurfaceContext, bot: Bot) {
  await ctx.flush();
  const { json } = await ctx.exportBot({ bot, includeMemory: false });
  const { bot: copy } = await ctx.importBot({ botId: newBotId(), json });
  // Same library items as the original; the copy's own file only carries redacted server settings.
  await addBot(ctx, {
    ...copy,
    name: `${bot.name} copy`,
    hostId: bot.hostId,
    cwd: bot.cwd,
    modeId: bot.modeId,
    alwaysAllow: bot.alwaysAllow,
    skillIds: bot.skillIds,
    mcpServerIds: bot.mcpServerIds,
    avatar: { ...bot.avatar, seed: randomSeed() },
  });
}

async function remove(ctx: SurfaceContext, bot: Bot) {
  const ok = await ctx.commit((values) => ({
    ...values,
    bots: values.bots.filter((entry) => entry.id !== bot.id),
    history: values.history.filter((entry) => entry.botId !== bot.id),
    groups: withoutBot(values.groups ?? [], bot.id, new Date().toISOString()),
  }));
  if (!ok) return;
  if (ctx.selection?.botId === bot.id) ctx.setSelection(null);
  ctx.updateUi((current) => {
    const { [bot.id]: _order, ...chatOrder } = current.chatOrder;
    return {
      ...current,
      collapsed: current.collapsed.filter((id) => id !== bot.id),
      pinnedChats: current.pinnedChats.filter((pin) => pin.botId !== bot.id),
      chatOrder,
    };
  });
}

function swapEntries<T extends { id: string }>(entries: readonly T[], first: string, second: string): T[] {
  const a = entries.find((entry) => entry.id === first);
  const b = entries.find((entry) => entry.id === second);
  if (!a || !b) return [...entries];
  return entries.map((entry) => (entry === a ? b : entry === b ? a : entry));
}

function withSwappedMembers(group: BotGroup, first: string, second: string): BotGroup {
  return {
    ...group,
    memberIds: group.memberIds.map((id) => (id === first ? second : id === second ? first : id)),
    updatedAt: new Date().toISOString(),
  };
}

function moveInTeam(ctx: SurfaceContext, group: BotGroup, botId: string, neighbourId: string) {
  if (botId === group.leadId || neighbourId === group.leadId) return undefined;
  return () =>
    void ctx.commit((values) => ({
      ...values,
      groups: (values.groups ?? []).map((entry) =>
        entry.id === group.id ? withSwappedMembers(entry, botId, neighbourId) : entry,
      ),
    }));
}

function moveBot(ctx: SurfaceContext, bot: Bot, delta: -1 | 1): (() => void) | undefined {
  const shown = ctx.openTab?.bots ?? ctx.listed;
  const index = shown.findIndex((entry) => entry.id === bot.id);
  const neighbour = shown[index + delta];
  if (index === -1 || !neighbour) return undefined;
  const group = ctx.openTab?.group;
  if (group) return moveInTeam(ctx, group, bot.id, neighbour.id);
  if (neighbour.pinned !== bot.pinned) return undefined;
  return () =>
    void ctx.commit((values) => ({ ...values, bots: swapEntries(values.bots, bot.id, neighbour.id) }));
}

function copyWithToast(ctx: SurfaceContext, text: string, done: string) {
  void copyText(text)
    .then(() => ctx.toast.show(done, { variant: "success" }))
    .catch(() => ctx.toast.error("Unable to copy"));
}

function workspaceOpener(ctx: SurfaceContext, bot: Bot): (() => void) | undefined {
  const botHost = ctx.resolveHost(bot.hostId);
  const chats =
    ctx.queryClient.getQueryData<PaseoAgent[]>(["paseo-bots", "chats", botHost.key, bot.id]) ?? [];
  const workspaceId = chats.find((chat) => chat.workspaceId)?.workspaceId;
  const openWorkspace = ctx.navigation?.openWorkspace;
  return openWorkspace && workspaceId && botHost.online
    ? () => openWorkspace({ workspaceId, serverId: botHost.key })
    : undefined;
}

function saveAsPreset(ctx: SurfaceContext, bot: Bot) {
  void ctx
    .flush()
    .then(() =>
      ctx.commit((values) => ({
        ...values,
        presets: [
          ...(values.presets ?? []),
          presetFromBot(values.bots.find((entry) => entry.id === bot.id) ?? bot),
        ],
      })),
    )
    .then(
      (saved) =>
        saved && ctx.toast.show(`Saved ${bot.name} as a preset. It's under New bot.`, { variant: "success" }),
    );
}

async function confirmRemove(ctx: SurfaceContext, bot: Bot) {
  const confirmed = await confirmDialog({
    title: "Delete bot?",
    message: `Delete "${bot.name}"?\n\nIts chats stay on the host and remain in Paseo's history.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    destructive: true,
  });
  if (confirmed) await remove(ctx, bot);
}

export function openBotMenu(ctx: SurfaceContext, bot: Bot, anchor: LayoutRectangle, source: MenuSource) {
  const onOpenInPaseo = workspaceOpener(ctx, bot);
  ctx.menu.open({
    anchor,
    align: source === "kebab" ? "end" : "start",
    width: 220,
    title: "Bot actions",
    entries: botMenuEntries({
      bot,
      onOpenInPaseo,
      onOpenSettings: () => openPanel(ctx, bot, "identity"),
      onTogglePin: () => void ctx.updateBot(bot.id, { pinned: !bot.pinned }),
      onMoveUp: moveBot(ctx, bot, -1),
      onMoveDown: moveBot(ctx, bot, 1),
      onRename: () => ctx.setRenaming(bot),
      onDuplicate: () =>
        duplicate(ctx, bot).catch((error: unknown) =>
          ctx.toast.error(`Couldn't duplicate: ${errorText(error)}`),
        ),
      onExport: () => ctx.setExporting(bot),
      onCopyId: () => copyWithToast(ctx, bot.id, "Bot ID copied"),
      onSaveAsPreset: () => saveAsPreset(ctx, bot),
      onToggleArchive: () => void ctx.updateBot(bot.id, { archived: !bot.archived }),
      onDelete: () => confirmRemove(ctx, bot),
    }),
  });
}

export async function deleteTeam(ctx: SurfaceContext, group: BotGroup) {
  const confirmed = await confirmDialog({
    title: "Delete team?",
    message: `Delete the "${group.name}" team? Its bots stay, without a team.`,
    confirmLabel: "Delete",
    cancelLabel: "Cancel",
    destructive: true,
  });
  if (!confirmed) return false;
  await ctx.commit((values) => ({
    ...values,
    groups: (values.groups ?? []).filter((entry) => entry.id !== group.id),
  }));
  return true;
}

export function openTeamMenu(ctx: SurfaceContext, group: BotGroup, anchor: LayoutRectangle) {
  ctx.menu.open({
    anchor,
    align: "end",
    width: 200,
    title: "Team actions",
    entries: [
      { label: "Edit team", icon: "Pencil", onSelect: () => ctx.setEditingTeam(group) },
      { label: "Team map", icon: "Network", onSelect: () => ctx.setTeamMap(true) },
      { kind: "separator" },
      {
        label: "Delete team",
        icon: "Trash2",
        destructive: true,
        onSelect: () => void deleteTeam(ctx, group),
      },
    ],
  });
}

function chatMover(ctx: SurfaceContext, { bot, chat, context }: ChatMenuRequest, delta: -1 | 1) {
  const order = moveKey(context.siblings, chat.id, delta);
  return order
    ? () => ctx.updateUi((current) => ({ ...current, chatOrder: { ...current.chatOrder, [bot.id]: order } }))
    : undefined;
}

async function copyTranscript(ctx: SurfaceContext, botHost: BotHost, { bot, chat }: ChatMenuRequest) {
  if (!botHost.api) {
    ctx.toast.error("Host is not connected");
    return;
  }
  try {
    const entries = await fullTimeline(botHost.api, chat.id);
    await copyText(
      chatTranscript({
        title: displayTitle(chat.title),
        botName: bot.name,
        entries,
        exportedAt: new Date(),
      }),
    );
    ctx.toast.show("Transcript copied", { variant: "success" });
  } catch (error) {
    ctx.toast.error(`Couldn't copy the transcript: ${errorText(error)}`);
  }
}

async function archiveChat(ctx: SurfaceContext, botHost: BotHost, { bot, chat, context }: ChatMenuRequest) {
  if (!botHost.api) {
    ctx.toast.error("Host is not connected");
    return;
  }
  try {
    await botHost.api.agents.ref(chat.id).archive();
    if (ctx.selection?.chatId === chat.id) ctx.setSelection({ botId: bot.id, chatId: null });
    if (context.pinned) {
      ctx.updateUi((current) => ({
        ...current,
        pinnedChats: current.pinnedChats.filter((pin) => pin.chatId !== chat.id),
      }));
    }
    await ctx.queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats", botHost.key, bot.id] });
  } catch (error) {
    ctx.toast.error(`Failed to archive chat: ${errorText(error)}`);
  }
}

export function openChatMenu(ctx: SurfaceContext, request: ChatMenuRequest) {
  const { bot, chat, anchor, source, context } = request;
  const botHost = ctx.resolveHost(bot.hostId);
  const openAgent = ctx.navigation?.openAgent;
  ctx.menu.open({
    anchor,
    align: source === "kebab" ? "end" : "start",
    width: 260,
    title: "Chat actions",
    entries: chatMenuEntries({
      pinned: context.pinned,
      onCopyPath: () =>
        chat.cwd ? copyWithToast(ctx, chat.cwd, "Path copied") : ctx.toast.error("Chat path not available"),
      onCopyId: () => copyWithToast(ctx, chat.id, "Chat ID copied"),
      onCopyTranscript: () => copyTranscript(ctx, botHost, request),
      onTogglePin: () =>
        ctx.updateUi((current) => ({
          ...current,
          pinnedChats: context.pinned
            ? current.pinnedChats.filter((pin) => pin.chatId !== chat.id)
            : [...current.pinnedChats, { botId: bot.id, chatId: chat.id }],
        })),
      move:
        context.pinned || ctx.listUi.chatSort !== "manual"
          ? null
          : { up: chatMover(ctx, request, -1), down: chatMover(ctx, request, 1) },
      onOpenInPaseo:
        openAgent && botHost.online
          ? () => openAgent({ agentId: chat.id, serverId: botHost.key })
          : undefined,
      onArchive: () => archiveChat(ctx, botHost, request),
    }),
  });
}

export function openDisplayMenu(ctx: SurfaceContext, anchor: LayoutRectangle) {
  const { listUi, archivedCount } = ctx;
  ctx.menu.open({
    anchor,
    align: "end",
    width: 232,
    title: "Display",
    entries: [
      {
        label: "Archived bots",
        trailing: listUi.showArchived ? "Shown" : archivedCount ? `Hidden (${archivedCount})` : "Hidden",
        onSelect: () => ctx.updateUi((current) => ({ ...current, showArchived: !current.showArchived })),
      },
      {
        label: "Chat order",
        trailing: listUi.chatSort === "manual" ? "Manual" : "Last activity",
        onSelect: () =>
          ctx.updateUi((current) => ({
            ...current,
            chatSort: current.chatSort === "manual" ? "activity" : "manual",
          })),
      },
    ],
  });
}

/** The chat header's bot menu has no anchor of its own; hang it from the pane's top-right corner. */
export function openBotMenuFromPane(ctx: SurfaceContext, bot: Bot) {
  void measureAnchor(ctx.paneRef).then((rect) =>
    openBotMenu(
      ctx,
      bot,
      rect
        ? { x: rect.x + rect.width - 44, y: rect.y, width: 36, height: 36 }
        : { x: 0, y: 0, width: 0, height: 0 },
      "kebab",
    ),
  );
}

export function commitWidth(ctx: SurfaceContext, key: "listWidth" | "panelWidth", width: number) {
  ctx.setDragWidths({});
  ctx.updateUi((current) => ({ ...current, [key]: Math.round(width) }));
}

export function saveTeamDraft(ctx: SurfaceContext, editing: BotGroup | "new", draft: TeamDraft) {
  const id = editing === "new" ? null : editing.id;
  const teamId = id ?? newGroupId();
  ctx.setEditingTeam(null);
  void ctx
    .commit((values) => ({
      ...values,
      groups: saveTeam(values.groups ?? [], {
        id,
        newId: teamId,
        draft,
        now: new Date().toISOString(),
      }),
    }))
    .then((saved) => saved && !id && ctx.updateUi((current) => ({ ...current, tab: teamId })));
}

export function createBot(ctx: SurfaceContext, start?: NewBotStart) {
  ctx.setCreating(false);
  const bot = start?.preset
    ? botFromPreset(ctx.defaultProvider(), start.preset)
    : newBot(ctx.defaultProvider(), start?.template);
  const defaults = ctx.values.defaults ?? DEFAULT_BOT_DEFAULTS;
  void addBot(ctx, applyDefaults(bot, defaults, ctx.defaultProvider()), start ? "overview" : "identity");
}

export async function importBots(ctx: SurfaceContext, json: string) {
  const { bots, teams } = await ctx.importTeam({ json });
  ctx.setCreating(false);
  const saved = await ctx.commit((values) => addImportedBots(values, bots, teams));
  const first = bots[0]?.bot;
  if (saved && first) {
    select(ctx, { botId: first.id, chatId: null });
    ctx.setPanel({ open: true, section: "overview" });
    if (bots.length > 1) ctx.toast.show(`Added ${bots.length} bots`, { variant: "success" });
  }
}

export async function renameBot(ctx: SurfaceContext, bot: Bot, name: string) {
  if (!(await ctx.updateBot(bot.id, { name }, true))) throw new Error("Unable to save");
  // The identity section holds its own copy of the name.
  if (ctx.panel.open && ctx.selection?.botId === bot.id) ctx.setPanelVersion((version) => version + 1);
}
