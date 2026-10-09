import { type BotDefaults, type BotSettingsValues, DEFAULT_BOT_DEFAULTS } from "../bot";
import { presetFromBot } from "../presets";

import { addRoutine, createBot, deleteBot, deleteRoutine, updateBot, updateRoutine } from "./bots";
import { type ApplyContext, accountId, carriedThinking, checkAgent } from "./context";
import { addMcpServer, removeMcpServer, setMcpServer, setSkill } from "./library";
import { byRef, findBot, findTeam } from "./refs";
import type { AppInputValue, Change, ChangeOf } from "./schema";
import { createTeam, updateTeam } from "./teams";

function setDefaults(
  values: BotSettingsValues,
  change: ChangeOf<"set_defaults">,
  context: ApplyContext,
): BotSettingsValues {
  const current = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const provider = change.provider !== undefined ? change.provider.trim() : current.provider;
  const carried =
    provider === current.provider ? current : { model: null, modeId: null, thinkingOptionId: null };
  const defaults: BotDefaults = {
    provider,
    model: change.model !== undefined ? change.model : carried.model,
    modeId: change.mode !== undefined ? change.mode : carried.modeId,
    thinkingOptionId: change.thinking !== undefined ? change.thinking : carried.thinkingOptionId,
    contactBots: change.contact_bots ?? current.contactBots,
  };
  if (change.thinking === undefined) defaults.thinkingOptionId = carriedThinking(context, defaults);
  checkAgent(context, {
    provider: defaults.provider,
    model: defaults.model,
    modeId: defaults.modeId,
    thinkingOptionId: defaults.thinkingOptionId,
  });
  return { ...values, defaults };
}

function deletePreset(values: BotSettingsValues, change: ChangeOf<"delete_preset">): BotSettingsValues {
  const presets = values.presets ?? [];
  const preset = byRef(presets, change.preset, {
    what: "preset",
    id: (entry) => entry.id,
    name: (entry) => entry.name,
  });
  return { ...values, presets: presets.filter((entry) => entry.id !== preset.id) };
}

function applyChange(values: BotSettingsValues, change: Change, context: ApplyContext): BotSettingsValues {
  switch (change.type) {
    case "create_bot":
      return createBot(values, change, context);
    case "update_bot":
      return updateBot(values, change, context);
    case "delete_bot":
      return deleteBot(values, change, context);
    case "add_routine":
      return addRoutine(values, change, context);
    case "update_routine":
      return updateRoutine(values, change, context);
    case "delete_routine":
      return deleteRoutine(values, change, context);
    case "create_team":
      return createTeam(values, change, context);
    case "update_team":
      return updateTeam(values, change, context);
    case "delete_team": {
      const group = findTeam(values, change.team);
      return { ...values, groups: (values.groups ?? []).filter((entry) => entry.id !== group.id) };
    }
    case "set_skill":
      return setSkill(values, change, context);
    case "add_mcp_server":
      return addMcpServer(values, change, context);
    case "set_mcp_server":
      return setMcpServer(values, change, context);
    case "remove_mcp_server":
      return removeMcpServer(values, change);
    case "set_defaults":
      return setDefaults(values, change, context);
    case "save_preset": {
      const bot = findBot(values, change.bot);
      return { ...values, presets: [...(values.presets ?? []), presetFromBot(bot, context.now)] };
    }
    case "delete_preset":
      return deletePreset(values, change);
  }
}

/** Throws naming the first change that doesn't fit. */
export function applyChanges(
  values: BotSettingsValues,
  changes: readonly Change[],
  context: ApplyContext,
): BotSettingsValues {
  return changes.reduce((current, change, index) => {
    try {
      return applyChange(current, change, context);
    } catch (error) {
      throw new Error(
        `Change ${index + 1} (${change.type}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, values);
}

/** Swaps app account names for their ids, since only the host can look them up. */
export function resolveChanges(changes: readonly Change[], context: ApplyContext): Change[] {
  const resolveApps = (apps: readonly AppInputValue[] | undefined) =>
    apps?.map((entry) =>
      entry.account
        ? { ...entry, account: accountId(entry.app.trim().toLowerCase(), entry.account, context) }
        : entry,
    );
  return changes.map((change) => {
    if (change.type === "create_bot") return { ...change, apps: resolveApps(change.apps) };
    if (change.type === "update_bot") return { ...change, add_apps: resolveApps(change.add_apps) };
    return change;
  });
}
