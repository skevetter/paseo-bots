import type { BotDefaults } from "./bot";
import { modeWords, type ProviderModes, runsUnattended } from "./bot-checks";

type Mode = NonNullable<ProviderModes["modes"]>[number];

/** `note` says why a new bot falls back to its provider's default mode. */
export interface StartingMode {
  modeId: string | null;
  note: string | null;
}

const ASKING_MODE_WORDS = /(^|-)(ask|default|manual|read-only)(-|$)/;

function askRank(mode: Mode): number {
  if (mode.colorTier === "safe") return 0;
  if (!mode.colorTier && ASKING_MODE_WORDS.test(modeWords(mode.id))) return 1;
  return 2;
}

function askingMode(provider: ProviderModes): string | null {
  const asking = (provider.modes ?? []).filter(
    (mode) => mode.colorTier !== "planning" && !runsUnattended({ modeId: mode.id }, provider),
  );
  const strictest = asking.reduce<Mode | undefined>(
    (best, mode) => (best && askRank(best) <= askRank(mode) ? best : mode),
    undefined,
  );
  return strictest?.id ?? null;
}

const WANTED = { ask: "asks first", unattended: "runs without asking" } as const;

function fallback(reason: string): StartingMode {
  return { modeId: null, note: `${reason}, so it starts in the default mode.` };
}

/** The approval mode a new bot on `providerId` starts in; null is the provider's default. */
export function startingMode(
  defaults: Pick<BotDefaults, "approval" | "modeByProvider">,
  providerId: string,
  provider: ProviderModes | undefined,
): StartingMode {
  const override = defaults.modeByProvider[providerId];
  if (override)
    return !provider?.modes || provider.modes.some((mode) => mode.id === override)
      ? { modeId: override, note: null }
      : fallback(`${providerId} has no mode "${override}"`);
  if (defaults.approval === "provider") return { modeId: null, note: null };
  if (!provider?.modes) return fallback(`${providerId || "The provider"}'s modes aren't known yet`);
  const modeId =
    defaults.approval === "ask"
      ? askingMode(provider)
      : (provider.modes.find((mode) => runsUnattended({ modeId: mode.id }, provider))?.id ?? null);
  return modeId
    ? { modeId, note: null }
    : fallback(`${providerId} has no mode that ${WANTED[defaults.approval]}`);
}
