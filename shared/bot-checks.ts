import type { Bot } from "./bot";

export const SOUL_MAX_BYTES = 24_000;

export interface ProviderModes {
  modes?: readonly { id: string; colorTier?: string | null }[];
  defaultModeId?: string | null;
}

const UNATTENDED_MODE_WORDS = /(^|-)(bypass|yolo|dangerous(ly)?|full-access|allow-all)(-|$)/;

/** Whether the bot's mode, or the provider's default when it has none, runs commands without asking. */
function runsUnattended(bot: Pick<Bot, "modeId">, provider: ProviderModes | undefined): boolean {
  const modeId = bot.modeId ?? provider?.defaultModeId;
  if (!modeId) return false;
  const tier = provider?.modes?.find((mode) => mode.id === modeId)?.colorTier;
  if (tier) return tier === "dangerous";
  const words = modeId
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
  return words === "full" || UNATTENDED_MODE_WORDS.test(words);
}

/**
 * `local`: runs on this host, where the plugin's tools and connected apps reach it.
 * `provider`: the bot's provider snapshot entry, when loaded.
 */
export function botLimits(
  bot: Bot,
  facts: { local: boolean; appsConfigured: boolean; provider?: ProviderModes },
): string[] {
  const lines: string[] = [];
  if (!runsUnattended(bot, facts.provider))
    lines.push("Asks before running commands and tools it isn't allowed to use.");
  if (!facts.local || bot.contactBots === "off") lines.push("Can't contact other bots.");
  else if (bot.contactBots === "ask") lines.push("Asks before contacting other bots.");
  if (!facts.local || !facts.appsConfigured || bot.apps.length === 0) lines.push("Has no connected apps.");
  if (!bot.routines.some((routine) => routine.enabled)) lines.push("Won't act on a schedule.");
  if (facts.local) lines.push("Keeps skills and routines only after you confirm them.");
  return lines;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function utf8CharBytes(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

export function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) bytes += utf8CharBytes(char);
  return bytes;
}

/** Kilobytes to one decimal, in the 1000-byte units the limits use. */
export function kb(bytes: number): string {
  return (bytes / 1000).toFixed(1);
}

/** `isLocalHost`: the bot runs on the storing host. */
export function botProblems(bot: Bot, isLocalHost: boolean): string[] {
  const problems: string[] = [];
  if (!bot.name.trim()) problems.push("Give the bot a name.");
  if (!bot.provider) problems.push("Pick an agent provider.");
  if (!isLocalHost && !bot.cwd) problems.push("Pick a working folder on the selected host.");
  if (utf8Bytes(bot.soul) > SOUL_MAX_BYTES)
    problems.push(`Standing instructions are over ${SOUL_MAX_BYTES / 1000} KB.`);
  return problems;
}
