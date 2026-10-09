import type { PluginTheme } from "@getpaseo/plugin";
import type { LayoutRectangle } from "react-native";
import type { Bot, BotGroup, BotListUi } from "../../shared/bot";
import type { TeamTab } from "../../shared/groups";
import type { LocalHost } from "../data";
import type { NativeTokens } from "../native";
import type { PaseoAgent } from "../paseo";

type Colors = PluginTheme["colors"];

/** A message to send as a new chat starts; each id starts at most one chat. */
export interface StartRequest {
  id: string;
  prompt: string;
}

export interface Selection {
  botId: string;
  /** Null is a new, not yet started chat. */
  chatId: string | null;
  start?: StartRequest;
}

export type MenuSource = "kebab" | "context";

export interface ChatMenuContext {
  /** The bot's unpinned chats in list order. */
  siblings: string[];
  pinned: boolean;
}

export interface ChatMenuRequest {
  bot: Bot;
  chat: PaseoAgent;
  anchor: LayoutRectangle;
  source: MenuSource;
  context: ChatMenuContext;
}

export interface BotSidebarProps {
  colors: Colors;
  bots: readonly Bot[];
  openTab: TeamTab | null;
  /** Keeps the header (and its menu) up when hidden archived bots are all that's left. */
  hiddenArchivedCount: number;
  selection: Selection | null;
  ui: BotListUi;
  localHost: LocalHost;
  /** Touch devices have no hover: row actions stay visible. */
  touch: boolean;
  /** With no bots at all, show the splash instead of the empty state. */
  splash?: boolean;
  bottomInset: number;
  onToggle(botId: string): void;
  onTogglePinnedSection(): void;
  onShowArchived(): void;
  onSelect(selection: Selection): void;
  onNewBot(): void;
  onBotMenu(bot: Bot, anchor: LayoutRectangle, source: MenuSource): void;
  onChatMenu(request: ChatMenuRequest): void;
  onDisplayMenu(anchor: LayoutRectangle): void;
  onEditTeam(group: BotGroup): void;
  onTeamMap(): void;
}

export type GroupProps = BotSidebarProps & {
  bot: Bot;
  tokens: NativeTokens;
  pinnedIds: ReadonlySet<string>;
  /** The team's Chief of Staff. */
  lead?: boolean;
};
