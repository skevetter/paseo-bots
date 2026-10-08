import { askBot, checkChat, listBots } from "./bots";
import { searchChats } from "./chats";
import type { BotTool } from "./mcp";
import { proposeRoutine } from "./routines";
import { getSetup, proposeChanges } from "./setup";
import { proposeSkill } from "./skills";

/** In the order agents see them. */
export const BOT_TOOLS: readonly BotTool[] = [
  listBots,
  askBot,
  checkChat,
  searchChats,
  getSetup,
  proposeSkill,
  proposeRoutine,
  proposeChanges,
];
