import { type Bot, type BotState, DEFAULT_BOT_DEFAULTS, EMPTY_LIBRARY } from "../bot";
import { newRoutineId } from "../bot-ids";

import { withoutBot } from "../groups";
import { scheduleFrom } from "../routines";
import { BOT_TEMPLATES, newBot } from "../templates";
import type { ApplyContext } from "./context";
import {
  uniqueBotName,
  withApps,
  withBot,
  withFields,
  withGrants,
  withLibraryItems,
  withPlaybooks,
} from "./fields";
import { byRef, findBot, ROUTINE_REF } from "./refs";
import type { ChangeOf } from "./schema";

export function createBot(values: BotState, change: ChangeOf<"create_bot">, context: ApplyContext): BotState {
  const library = values.library ?? EMPTY_LIBRARY;
  const defaults = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const template = BOT_TEMPLATES.find((entry) => entry.id === change.role);
  const base = newBot(defaults.provider || context.provider, template);
  const same = !!defaults.provider;
  let bot: Bot = {
    ...base,
    name: uniqueBotName(values, change.name),
    model: same ? defaults.model : null,
    modeId: same ? defaults.modeId : null,
    thinkingOptionId: same ? defaults.thinkingOptionId : null,
    contactBots: defaults.contactBots,
    createdAt: context.now,
  };
  bot = withFields(bot, change, context);
  bot = withLibraryItems(bot, library, "skill", { add: change.skills });
  bot = withLibraryItems(bot, library, "mcp", { add: change.mcp_servers });
  bot = withApps(bot, { add: change.apps }, context);
  bot = withPlaybooks(bot, change.playbooks);
  return withBot(values, bot, context);
}

export function updateBot(values: BotState, change: ChangeOf<"update_bot">, context: ApplyContext): BotState {
  const library = values.library ?? EMPTY_LIBRARY;
  let bot = findBot(values, change.bot);
  if (change.name !== undefined) bot = { ...bot, name: uniqueBotName(values, change.name, bot.id) };
  bot = withFields(bot, change, context);
  if (change.archived !== undefined) bot = { ...bot, archived: change.archived };
  bot = withLibraryItems(bot, library, "skill", { add: change.add_skills, remove: change.remove_skills });
  bot = withLibraryItems(bot, library, "mcp", {
    add: change.add_mcp_servers,
    remove: change.remove_mcp_servers,
  });
  bot = withApps(bot, { add: change.add_apps, remove: change.remove_apps }, context);
  bot = withGrants(bot, change.allow_tools, change.disallow_tools);
  bot = withPlaybooks(bot, change.add_playbooks, change.remove_playbooks);
  return withBot(values, bot, context);
}

export function deleteBot(values: BotState, change: ChangeOf<"delete_bot">, context: ApplyContext): BotState {
  const bot = findBot(values, change.bot);
  const ui = values.ui;
  const { [bot.id]: _order, ...chatOrder } = ui?.chatOrder ?? {};
  return {
    ...values,
    bots: values.bots.filter((entry) => entry.id !== bot.id),
    history: values.history.filter((entry) => entry.botId !== bot.id),
    groups: withoutBot(values.groups ?? [], bot.id, context.now),
    ui: ui && {
      ...ui,
      collapsed: ui.collapsed.filter((id) => id !== bot.id),
      pinnedChats: ui.pinnedChats.filter((pin) => pin.botId !== bot.id),
      chatOrder,
    },
  };
}

export function addRoutine(
  values: BotState,
  change: ChangeOf<"add_routine">,
  context: ApplyContext,
): BotState {
  const bot = findBot(values, change.bot);
  const routine = {
    id: newRoutineId(),
    name: change.name.trim(),
    prompt: change.instructions.trim(),
    enabled: true,
    schedule: scheduleFrom(change.schedule, new Date(context.now)),
    resultsChatId: null,
    createdAt: context.now,
  };
  return withBot(values, { ...bot, routines: [...bot.routines, routine] }, context);
}

export function updateRoutine(
  values: BotState,
  change: ChangeOf<"update_routine">,
  context: ApplyContext,
): BotState {
  const bot = findBot(values, change.bot);
  const routine = byRef(bot.routines, change.routine, ROUTINE_REF);
  const updated = {
    ...routine,
    name: change.name?.trim() ?? routine.name,
    prompt: change.instructions?.trim() ?? routine.prompt,
    schedule: change.schedule ? scheduleFrom(change.schedule, new Date(context.now)) : routine.schedule,
    enabled: change.enabled ?? routine.enabled,
  };
  return withBot(
    values,
    { ...bot, routines: bot.routines.map((entry) => (entry.id === routine.id ? updated : entry)) },
    context,
  );
}

export function deleteRoutine(
  values: BotState,
  change: ChangeOf<"delete_routine">,
  context: ApplyContext,
): BotState {
  const bot = findBot(values, change.bot);
  const routine = byRef(bot.routines, change.routine, ROUTINE_REF);
  return withBot(
    values,
    { ...bot, routines: bot.routines.filter((entry) => entry.id !== routine.id) },
    context,
  );
}
