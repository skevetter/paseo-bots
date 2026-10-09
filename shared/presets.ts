import { startingMode } from "./approval";
import type { Bot, BotDefaults, Preset } from "./bot";
import type { ProviderModesById } from "./bot-checks";
import { prefixedId } from "./uuid";

export function presetFromBot(bot: Bot, now: string = new Date().toISOString()): Preset {
  return {
    id: prefixedId("pr"),
    name: bot.name,
    title: bot.title,
    description: bot.description,
    avatar: bot.avatar,
    soul: bot.soul,
    playbooks: bot.playbooks,
    skillIds: bot.skillIds,
    createdAt: now,
  };
}

/** `note` says why the bot fell back to its provider's default mode. */
export function applyDefaults(
  bot: Bot,
  defaults: BotDefaults,
  providers: ProviderModesById,
): { bot: Bot; note: string | null } {
  // A model or thinking level only means something for the provider it was picked for.
  const same = !!defaults.provider && defaults.provider === bot.provider;
  const mode = startingMode(defaults, bot.provider, providers[bot.provider]);
  return {
    bot: {
      ...bot,
      model: same ? defaults.model : null,
      modeId: mode.modeId,
      thinkingOptionId: same ? defaults.thinkingOptionId : null,
      contactBots: defaults.contactBots,
    },
    note: mode.note && `${bot.name}: ${mode.note}`,
  };
}
