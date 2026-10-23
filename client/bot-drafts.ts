import { type Bot, BotSchema, type BotState } from "../shared/bot";
import { pushHistory } from "../shared/bot-history";
import { patchBotOverrides } from "../shared/policies";

export interface BotDraft {
  base: Bot;
  value: Bot;
  recordHistory: boolean;
}
export type BotDrafts = Record<string, BotDraft>;
export interface DraftConflict {
  botId: string;
  kind: "changed" | "deleted" | "identity";
  fields: string[];
  message: string;
}
export class DraftConflictError extends Error {
  constructor(readonly conflict: DraftConflict) {
    super(conflict.message);
    this.name = "DraftConflictError";
  }
}

// Execution selectors, grants and executable context cannot be independently combined across revisions.
const EXECUTION_FIELDS: Partial<Record<keyof Bot, true>> = {
  provider: true,
  model: true,
  thinkingOptionId: true,
  modeId: true,
  policy: true,
  executionMode: true,
  hostId: true,
  cwd: true,
  soul: true,
  description: true,
  mcpServerIds: true,
  alwaysAllow: true,
  skillIds: true,
  apps: true,
  appRules: true,
  contactBots: true,
  routines: true,
  playbooks: true,
  archived: true,
};

function changedFields(before: Bot, after: Bot): (keyof Bot)[] {
  // These are keys of already validated Bot values; the merge never descends into objects or arrays.
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])] as (keyof Bot)[];
  return keys.filter(
    (key) => key !== "updatedAt" && JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
}

export function captureDraft(base: Bot, patch: Partial<Bot>, recordHistory = true): BotDraft {
  return {
    base: BotSchema.parse(base),
    value: patchBotOverrides(base, { ...patch, updatedAt: new Date().toISOString() }),
    recordHistory,
  };
}

export function editDraft(draft: BotDraft, patch: Partial<Bot>, recordHistory = true): BotDraft {
  return {
    base: draft.base,
    value: patchBotOverrides(draft.value, { ...patch, updatedAt: new Date().toISOString() }),
    recordHistory: draft.recordHistory || recordHistory,
  };
}

export function draftChanged(draft: BotDraft): boolean {
  return changedFields(draft.base, draft.value).length !== 0;
}

export interface DraftEditOptions {
  recordHistory: boolean;
  inFlight?: BotDraft;
}

export function stageDrafts(
  current: BotDrafts,
  base: Bot,
  patch: Partial<Bot>,
  options: DraftEditOptions,
): BotDrafts {
  const existing = current[base.id];
  const draft = existing
    ? editDraft(existing, patch, options.recordHistory)
    : captureDraft(base, patch, options.recordHistory);
  // Returning to the old baseline is still a V2 edit while its V1 is being saved.
  if (draftChanged(draft) || options.inFlight) return { ...current, [base.id]: draft };
  if (!existing) return current;
  const next = { ...current };
  delete next[base.id];
  return next;
}

function rebaseDraft(fresh: Bot, draft: BotDraft, now: string): Bot {
  const { base, value } = draft;
  if (
    fresh.id !== base.id ||
    value.id !== base.id ||
    fresh.createdAt !== base.createdAt ||
    value.createdAt !== base.createdAt
  )
    throw new DraftConflictError({
      botId: base.id,
      kind: "identity",
      fields: ["id", "createdAt"],
      message: "This bot's identity changed. Discard the draft and review the saved bot.",
    });
  const local = changedFields(base, value);
  const remote = changedFields(base, fresh);
  const overlap = local.filter((field) => remote.includes(field));
  const localExecution = local.filter((field) => EXECUTION_FIELDS[field]);
  const remoteExecution = remote.filter((field) => EXECUTION_FIELDS[field]);
  const dependent =
    localExecution.length && remoteExecution.length ? [...localExecution, ...remoteExecution] : [];
  const conflicts = [...new Set([...overlap, ...dependent])];
  if (conflicts.length)
    throw new DraftConflictError({
      botId: base.id,
      kind: "changed",
      fields: conflicts,
      message: `Saved bot fields changed while editing: ${conflicts.join(", ")}. No draft was written. Discard and review the saved bot before editing again.`,
    });
  if (local.length === 0) return fresh;
  return { ...fresh, ...Object.fromEntries(local.map((field) => [field, value[field]])), updatedAt: now };
}

/** Re-runs against each authoritative CAS revision; untouched fresh fields and receipts are retained. */
export function applyDrafts(values: BotState, pending: BotDrafts, now = new Date().toISOString()): BotState {
  const rebased = new Map<string, Bot>();
  for (const [id, draft] of Object.entries(pending)) {
    const fresh = values.bots.find((bot) => bot.id === id);
    if (!fresh)
      throw new DraftConflictError({
        botId: id,
        kind: "deleted",
        fields: [],
        message:
          "The saved bot was deleted. Its unsaved draft was retained for review and must be discarded; saving cannot recreate it.",
      });
    rebased.set(id, rebaseDraft(fresh, draft, now));
  }
  let history = values.history;
  const bots = values.bots.map((bot) => {
    const next = rebased.get(bot.id);
    if (!next || next === bot) return bot;
    if (pending[bot.id]?.recordHistory) history = pushHistory(history, bot, new Date(now));
    return next;
  });
  return { ...values, bots, history };
}

function advanceDraft(pending: BotDraft, earlier: BotDraft, saved: Bot): BotDraft | null {
  if (pending === earlier) return null;
  const later = changedFields(earlier.value, pending.value);
  const advanced = {
    base: BotSchema.parse(saved),
    value: {
      ...saved,
      ...Object.fromEntries(later.map((field) => [field, pending.value[field]])),
      updatedAt: pending.value.updatedAt,
    },
    recordHistory: pending.recordHistory,
  };
  return draftChanged(advanced) ? advanced : null;
}

/** An own V1 acknowledgement advances V2's baseline, applying only edits made after the captured V1. */
export function acknowledgeDrafts(current: BotDrafts, captured: BotDrafts, saved: BotState): BotDrafts {
  const next = { ...current };
  for (const [id, earlier] of Object.entries(captured)) {
    const pending = next[id];
    if (!pending || pending.base !== earlier.base) continue;
    const bot = saved.bots.find((entry) => entry.id === id);
    if (!bot) continue;
    const advanced = advanceDraft(pending, earlier, bot);
    if (advanced) next[id] = advanced;
    else delete next[id];
  }
  return next;
}
