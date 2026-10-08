import { serverToolName } from "./tool-name";

export const TOOLS_MCP_NAME = "bots";

const BOT_TOOL_NAMES = [
  "list_bots",
  "ask_bot",
  "check_chat",
  "search_chats",
  "get_setup",
  "propose_skill",
  "propose_routine",
  "propose_changes",
  "connect_app",
] as const;
export type BotToolName = (typeof BOT_TOOL_NAMES)[number];

/**
 * Read-only or propose-and-confirm tools, so they run without a permission
 * prompt. ask_bot is governed by the bot's "Contact other bots" setting.
 */
export const QUIET_TOOLS: readonly BotToolName[] = [
  "list_bots",
  "check_chat",
  "search_chats",
  "get_setup",
  "propose_skill",
  "propose_routine",
  "propose_changes",
  "connect_app",
];

export function botToolName(name: string): BotToolName | null {
  const tool = serverToolName(name, TOOLS_MCP_NAME);
  return tool && (BOT_TOOL_NAMES as readonly string[]).includes(tool) ? (tool as BotToolName) : null;
}

/** Paseo refuses the chat when other providers get exact MCP tool grants. */
export function supportsToolGrants(provider: string): boolean {
  return /^(claude|codex|opencode)(\b|$)/.test(provider);
}

export function botToolsPrompt(canAsk: boolean): string {
  const others = canAsk
    ? "list_bots to see the other bots and ask_bot to ask one for help (check_chat follows up)"
    : "list_bots to see the other bots";
  return `Your own tools come from the MCP server "bots". Use propose_routine for your own recurring or webhook-started work (rather than Paseo schedules) and propose_skill to keep a way of working for next time. When the user asks you to set up or change bots, teams, skills, MCP servers or defaults, read get_setup and put all the changes in one propose_changes call. The user confirms proposals on a card in the chat. Use search_chats to look through your past chats and daily log, and ${others}.`;
}
