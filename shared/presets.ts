import type { Bot, BotDefaults, Preset } from "./bot";

function newPresetId(): string {
  return `pr-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function presetFromBot(bot: Bot, now: string = new Date().toISOString()): Preset {
  return {
    id: newPresetId(),
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

export function applyDefaults(bot: Bot, defaults: BotDefaults, provider: string): Bot {
  const chosen = defaults.provider || provider;
  // A model, mode or thinking level only means something for the provider it was picked for.
  const same = !!defaults.provider;
  return {
    ...bot,
    provider: chosen,
    model: same ? defaults.model : null,
    modeId: same ? defaults.modeId : null,
    thinkingOptionId: same ? defaults.thinkingOptionId : null,
    contactBots: defaults.contactBots,
  };
}
