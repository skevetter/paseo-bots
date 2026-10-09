import { type Bot, type BotState, EMPTY_LIBRARY, type TeamFileTeam } from "./bot";
import { type ProviderModes, runsUnattended } from "./bot-checks";
import { isBrowserServer } from "./browser";
import { applyChanges } from "./changes/apply";
import { addImportedBots, type ImportedBot } from "./library";
import type { Proposal } from "./proposals";

/** Provider id to its modes, as Paseo's provider snapshot lists them. */
export type ProviderModesById = Readonly<Record<string, ProviderModes>>;

interface Facts {
  browserBefore: ReadonlySet<string>;
  browserAfter: ReadonlySet<string>;
  providers: ProviderModesById;
}

/** Only a mode that's set counts; the provider's default is what the app gives every new bot. */
function unattended(bot: Pick<Bot, "modeId" | "provider">, providers: ProviderModesById): boolean {
  return bot.modeId !== null && runsUnattended(bot, providers[bot.provider]);
}

function botElevations(bot: Bot, before: Bot | undefined, facts: Facts): string[] {
  const reasons: string[] = [];
  const had = new Set((before?.mcpServerIds ?? []).filter((id) => facts.browserBefore.has(id)));
  if (bot.mcpServerIds.some((id) => facts.browserAfter.has(id) && !had.has(id)))
    reasons.push(`${bot.name} gets the Browser server, which acts as you in your browser.`);
  if (unattended(bot, facts.providers) && !(before && unattended(before, facts.providers)))
    reasons.push(`${bot.name} runs in approval mode "${bot.modeId}", which acts without asking.`);
  return reasons;
}

function defaultsElevation(before: BotState, after: BotState, providers: ProviderModesById): string[] {
  const starts = (values: BotState) =>
    !!values.defaults &&
    unattended({ provider: values.defaults.provider, modeId: values.defaults.modeId }, providers);
  return starts(after) && !starts(before)
    ? [`New bots start in approval mode "${after.defaults?.modeId}", which acts without asking.`]
    : [];
}

function browserIds(values: BotState): Set<string> {
  const library = values.library ?? EMPTY_LIBRARY;
  return new Set(library.mcpServers.filter(isBrowserServer).map((server) => server.id));
}

/** What `after` allows that `before` didn't and that needs the user's approval in the app. */
export function elevations(before: BotState, after: BotState, providers: ProviderModesById = {}): string[] {
  const facts = { browserBefore: browserIds(before), browserAfter: browserIds(after), providers };
  const previous = new Map(before.bots.map((bot) => [bot.id, bot]));
  return [
    ...after.bots.flatMap((bot) => botElevations(bot, previous.get(bot.id), facts)),
    ...defaultsElevation(before, after, providers),
  ];
}

/** MCP servers the file brings, and anything its bots would get that needs approval. */
export function importElevations(
  values: BotState,
  imported: { bots: readonly ImportedBot[]; teams: readonly TeamFileTeam[] },
  providers: ProviderModesById = {},
): string[] {
  const servers = new Set(
    imported.bots.flatMap((entry) =>
      entry.mcpServers
        .filter((server) => !isBrowserServer({ id: "", config: server.config }))
        .map((server) => server.name),
    ),
  );
  return [
    ...(servers.size ? [`Brings in the MCP servers ${[...servers].join(", ")}.`] : []),
    ...elevations(values, addImportedBots(values, imported.bots, imported.teams), providers),
  ];
}

/** A changes proposal that no longer applies counts as not elevated; accepting it fails anyway. */
export function proposalElevations(
  proposal: Proposal,
  values: BotState,
  providers: ProviderModesById = {},
): string[] {
  switch (proposal.kind) {
    case "changes": {
      const context = { now: new Date().toISOString(), provider: proposal.data.provider };
      try {
        return elevations(values, applyChanges(values, proposal.data.changes, context), providers);
      } catch {
        return [];
      }
    }
    case "command":
      return [`Lets the bot run \`${proposal.data.command}\` in ${proposal.data.cwd} without asking.`];
    case "import":
      return importElevations(values, proposal.data, providers);
    default:
      return [];
  }
}
