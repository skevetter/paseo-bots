import { z } from "zod";
import type { Bot, Routine } from "../../../shared/bot";
import { byRef, findBot, ROUTINE_REF } from "../../../shared/changes/refs";
import type { Change } from "../../../shared/changes/schema";
import { describeSchedule, nextRun, ScheduleInput } from "../../../shared/routines";
import {
  applyOrPropose,
  BotRef,
  botByRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  result,
} from "../tool";

const RoutineRef = z.string().min(1).max(100).describe("The routine's name or id.");
const ResultsChat = z
  .string()
  .min(1)
  .max(200)
  .nullable()
  .optional()
  .describe("A chat id that gets a card for each run. null posts results only in the run's own chat.");

function summary(bot: Bot, routine: Routine, lastRunAt: string | null) {
  const now = new Date();
  const next = routine.enabled
    ? nextRun(routine.schedule, new Date(lastRunAt ?? routine.createdAt), now)
    : null;
  return {
    id: routine.id,
    bot: bot.id,
    botName: bot.name,
    name: routine.name,
    instructions: routine.prompt,
    schedule: describeSchedule(routine.schedule),
    kind: routine.schedule.kind,
    enabled: routine.enabled,
    nextRun: next?.toISOString() ?? null,
    resultsChatId: routine.resultsChatId,
  };
}

async function routineByRef(context: ControlContext, botRef: string, ref: string) {
  const bot = await botByRef(context, botRef);
  return { bot, routine: byRef(bot.routines, ref, ROUTINE_REF) };
}

/** add_routine always starts without a results chat, so the app's option is set right after. */
async function setResultsChat(
  context: ControlContext,
  botId: string,
  routineId: string,
  chat: string | null,
) {
  const saved = await context.host.store.update((values) => ({
    ...values,
    bots: values.bots.map((bot) =>
      bot.id === botId
        ? {
            ...bot,
            routines: bot.routines.map((entry) =>
              entry.id === routineId ? { ...entry, resultsChatId: chat } : entry,
            ),
          }
        : bot,
    ),
  }));
  return byRef(findBot(saved.values, botId).routines, routineId, ROUTINE_REF);
}

async function change(context: ControlContext, text: string, changes: Change[]) {
  const outcome = await applyOrPropose(context, text, changes);
  return outcome.status === "pending" ? { pending: outcome.result } : { values: outcome.values };
}

async function setEnabled(context: ControlContext, botRef: string, ref: string, enabled: boolean) {
  const { bot, routine } = await routineByRef(context, botRef, ref);
  const done = await change(context, `${enabled ? "Resume" : "Pause"} ${routine.name}`, [
    { type: "update_routine", bot: bot.id, routine: routine.id, enabled },
  ]);
  if (done.pending) return done.pending;
  return result(`${routine.name} is ${enabled ? "on" : "paused"}.`, { routine: routine.id, enabled });
}

const list = defineControlTool({
  name: "routines_list",
  description: "List routines with their schedule, whether they're on, and the next run.",
  input: z.object({ bot: BotRef.optional().describe("Only this bot's routines. All bots when left out.") }),
  annotations: { readOnlyHint: true },
  async run({ bot }, context) {
    const values = await context.host.values();
    const bots = bot ? [findBot(values, bot)] : values.bots;
    const { routines: records } = await context.scheduler.status();
    const routines = bots.flatMap((entry) =>
      entry.routines.map((routine) => summary(entry, routine, records[routine.id]?.lastRunAt ?? null)),
    );
    const text = routines.length
      ? routines
          .map(
            (routine) =>
              `${routine.botName}: ${routine.name} (${routine.enabled ? routine.schedule : "paused"})`,
          )
          .join("\n")
      : "No routines.";
    return result(text, { routines });
  },
});

const create = defineControlTool({
  name: "routines_create",
  description: "Add a routine to a bot.",
  input: z.object({
    bot: BotRef,
    name: z.string().min(1).max(80),
    instructions: z.string().min(1).max(20_000).describe("What to do on each run."),
    schedule: ScheduleInput,
    results_chat_id: ResultsChat,
  }),
  async run({ bot: ref, name, instructions, schedule, results_chat_id }, context) {
    const bot = await botByRef(context, ref);
    const done = await change(context, `Add routine ${name}`, [
      { type: "add_routine", bot: bot.id, name, instructions, schedule },
    ]);
    if (done.pending) return done.pending;
    const known = new Set(bot.routines.map((entry) => entry.id));
    const after = findBot(done.values, bot.id);
    let routine = after.routines.find((entry) => !known.has(entry.id));
    if (!routine) throw new Error("The routine wasn't saved.");
    if (results_chat_id) routine = await setResultsChat(context, bot.id, routine.id, results_chat_id);
    return result(`Added ${routine.name}: ${describeSchedule(routine.schedule)}.`, {
      routine: summary(after, routine, null),
    });
  },
});

const update = defineControlTool({
  name: "routines_update",
  description: "Change a routine's name, instructions, schedule, results chat or whether it's on.",
  input: z.object({
    bot: BotRef,
    routine: RoutineRef,
    name: z.string().min(1).max(80).optional(),
    instructions: z.string().min(1).max(20_000).optional(),
    schedule: ScheduleInput.optional(),
    enabled: z.boolean().optional().describe("false pauses it."),
    results_chat_id: ResultsChat,
  }),
  async run({ bot: botRef, routine: ref, results_chat_id, ...fields }, context) {
    const { bot, routine } = await routineByRef(context, botRef, ref);
    const done = await change(context, `Update routine ${routine.name}`, [
      { type: "update_routine", bot: bot.id, routine: routine.id, ...fields },
    ]);
    if (done.pending) return done.pending;
    let updated = byRef(findBot(done.values, bot.id).routines, routine.id, ROUTINE_REF);
    if (results_chat_id !== undefined)
      updated = await setResultsChat(context, bot.id, routine.id, results_chat_id);
    const { routines } = await context.scheduler.status();
    return result(`Updated ${updated.name}.`, {
      routine: summary(bot, updated, routines[routine.id]?.lastRunAt ?? null),
    });
  },
});

const remove = defineControlTool({
  name: "routines_delete",
  description: "Delete a routine.",
  input: z.object({ bot: BotRef, routine: RoutineRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ bot: botRef, routine: ref }, context) {
    const { bot, routine } = await routineByRef(context, botRef, ref);
    const done = await change(context, `Delete routine ${routine.name}`, [
      { type: "delete_routine", bot: bot.id, routine: routine.id },
    ]);
    if (done.pending) return done.pending;
    return result(`Deleted ${routine.name}.`, { deleted: routine.id });
  },
});

const enable = defineControlTool({
  name: "routines_enable",
  description: "Turn a paused routine back on.",
  input: z.object({ bot: BotRef, routine: RoutineRef }),
  run: ({ bot, routine }, context) => setEnabled(context, bot, routine, true),
});

const disable = defineControlTool({
  name: "routines_disable",
  description: "Pause a routine.",
  input: z.object({ bot: BotRef, routine: RoutineRef }),
  run: ({ bot, routine }, context) => setEnabled(context, bot, routine, false),
});

const runNow = defineControlTool({
  name: "routines_run_now",
  description: "Run a routine now in a new chat. Needs Paseo open.",
  input: z.object({ bot: BotRef, routine: RoutineRef }),
  async run({ bot: botRef, routine: ref }, context) {
    context.host.requirePaseo();
    const { bot, routine } = await routineByRef(context, botRef, ref);
    const { run } = await context.scheduler.runNow(bot.id, routine.id);
    const detail = run.error ? `: ${run.error}` : "";
    return result(`${routine.name}: ${run.status}${detail}.`, { run });
  },
});

const status = defineControlTool({
  name: "routines_status",
  description: "Whether the scheduler is running, and each routine's last run.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_input, context) {
    const { scheduler, routines } = await context.scheduler.status();
    const last = Object.fromEntries(
      Object.entries(routines).map(([id, record]) => [
        id,
        { lastRunAt: record.lastRunAt, lastRun: record.runs.at(-1) ?? null },
      ]),
    );
    return result(scheduler ? "The scheduler is running." : "The scheduler waits for Paseo to open.", {
      scheduler,
      routines: last,
    });
  },
});

const history = defineControlTool({
  name: "routines_history",
  description: "A routine's runs, newest first.",
  input: z.object({ bot: BotRef, routine: RoutineRef }),
  annotations: { readOnlyHint: true },
  async run({ bot, routine: ref }, context) {
    const { routine } = await routineByRef(context, bot, ref);
    const { routines } = await context.scheduler.status();
    const runs = [...(routines[routine.id]?.runs ?? [])].reverse();
    const text = runs.length
      ? runs.map((run) => `${run.startedAt} ${run.trigger}: ${run.status}`).join("\n")
      : `${routine.name} hasn't run yet.`;
    return result(text, { routine: routine.id, runs });
  },
});

const webhook = defineControlTool({
  name: "routines_webhook",
  description: "The URL that runs a webhook routine when called with POST.",
  input: z.object({
    bot: BotRef,
    routine: RoutineRef,
    rotate: z.boolean().optional().describe("true replaces the URL; the old one stops working."),
  }),
  async run({ bot, routine: ref, rotate }, context) {
    const { routine } = await routineByRef(context, bot, ref);
    if (routine.schedule.kind !== "webhook") throw new Error(`${routine.name} doesn't run from a webhook.`);
    const { url } = await context.scheduler.webhookUrl(routine.id, rotate ?? false);
    return result(url, { url });
  },
});

export const ROUTINE_TOOLS: readonly ControlTool[] = [
  list,
  create,
  update,
  remove,
  enable,
  disable,
  runNow,
  status,
  history,
  webhook,
];
