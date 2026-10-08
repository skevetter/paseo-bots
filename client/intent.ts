import type { PluginOpenScreenInput, PluginScreenParams } from "@getpaseo/plugin/client";

export const BOTS_SCREEN = "bots";

export function newBotScreen(): PluginOpenScreenInput {
  return { screenId: BOTS_SCREEN, params: { newBot: String(Date.now()) } };
}

let handledNewBot: string | null = null;

/** Whether these params ask for a new bot not asked for yet: back, forward and remounts keep the params. */
export function takeNewBotRequest(params: PluginScreenParams): boolean {
  const request = params.newBot;
  if (!request || request === handledNewBot) return false;
  handledNewBot = request;
  return true;
}
