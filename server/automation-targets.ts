import { createHash } from "node:crypto";
import type { Bot, BotState, Routine } from "../shared/bot";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}

export const automationHash = (value: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

export interface AutomationTarget {
  id: string;
  bot: Bot;
  routine: Routine;
}

/** A target is keyed by opaque bot/routine identity, never by its name, position or a parsed composite ID. */
export function automationTargets(values: BotState): Map<string, AutomationTarget> {
  const targets = new Map<string, AutomationTarget>();
  for (const bot of values.bots) {
    for (const routine of bot.routines) {
      const id = `rtn-${automationHash([bot.id, routine.id])}`;
      if (targets.has(id))
        throw new Error(
          "Duplicate routine identities in bot configuration. Repair them before changing routines.",
        );
      targets.set(id, { id, bot, routine });
    }
  }
  return targets;
}
