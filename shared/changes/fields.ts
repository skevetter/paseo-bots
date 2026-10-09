import type { z } from "zod";
import { randomSeed } from "../avatar";
import {
  type Bot,
  type BotAvatar,
  type BotSettingsValues,
  type Library,
  newPlaybookId,
  pushHistory,
} from "../bot";
import { setBotUses } from "../library";
import { type ApplyContext, accountId, checkAgent } from "./context";
import { findServer, findSkill } from "./refs";
import type { AppInputValue, AvatarInput, BotFieldValues, PlaybookInput } from "./schema";

const IMAGE_URL = /^(https?:\/\/\S+|data:image\/\S+)$/i;
const APP_SLUG = /^[a-z0-9_-]{1,60}$/i;
const TOOL_GRANT = /^[A-Za-z0-9_-]{1,64}\/\S{1,200}$/;

export function imageUrl(value: string | null): string | null {
  if (value !== null && !IMAGE_URL.test(value.trim()))
    throw new Error("A picture needs an https:// or data:image URL.");
  return value?.trim() ?? null;
}

export function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function withAvatar(avatar: BotAvatar, input: z.infer<typeof AvatarInput> | undefined): BotAvatar {
  if (!input) return avatar;
  return {
    seed: input.new_face ? randomSeed() : avatar.seed,
    palette: input.colour !== undefined ? input.colour : avatar.palette,
    shape: input.shape ?? avatar.shape,
    imageUrl:
      input.image_url !== undefined ? imageUrl(input.image_url) : input.new_face ? null : avatar.imageUrl,
  };
}

function withAgent(bot: Bot, fields: BotFieldValues, context: ApplyContext): Bot {
  const provider = fields.provider ?? bot.provider;
  // A model, mode or thinking level belongs to the provider it was picked for.
  const defaultMode = context.providers?.find((entry) => entry.id === provider)?.defaultModeId ?? null;
  const carried =
    provider === bot.provider ? bot : { model: null, modeId: defaultMode, thinkingOptionId: null };
  const next = {
    ...bot,
    provider,
    model: fields.model !== undefined ? fields.model : carried.model,
    modeId: fields.mode !== undefined ? fields.mode : carried.modeId,
    thinkingOptionId: fields.thinking !== undefined ? fields.thinking : carried.thinkingOptionId,
  };
  if (
    fields.provider !== undefined ||
    fields.model !== undefined ||
    fields.mode !== undefined ||
    fields.thinking !== undefined
  )
    checkAgent(context, next);
  return next;
}

function workingFolder(value: string | null): string | null {
  const folder = value?.trim() || null;
  if (folder && !folder.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(folder))
    throw new Error("A working folder needs an absolute path.");
  return folder;
}

export function withFields(bot: Bot, fields: BotFieldValues, context: ApplyContext): Bot {
  const next: Bot = withAgent({ ...bot, avatar: withAvatar(bot.avatar, fields.avatar) }, fields, context);
  if (fields.title !== undefined) next.title = oneLine(fields.title);
  if (fields.description !== undefined) next.description = fields.description.trim();
  if (fields.instructions !== undefined) next.soul = fields.instructions.trim();
  if (fields.contact_bots !== undefined) next.contactBots = fields.contact_bots;
  if (fields.working_folder !== undefined) next.cwd = workingFolder(fields.working_folder);
  if (fields.pinned !== undefined) next.pinned = fields.pinned;
  return next;
}

export function withLibraryItems(
  bot: Bot,
  library: Library,
  kind: "skill" | "mcp",
  refs: { add?: readonly string[]; remove?: readonly string[] },
): Bot {
  let next = bot;
  const id = (ref: string) => (kind === "skill" ? findSkill(library, ref).id : findServer(library, ref).id);
  for (const ref of refs.add ?? []) next = setBotUses(next, kind, id(ref), true);
  for (const ref of refs.remove ?? []) next = setBotUses(next, kind, id(ref), false);
  return next;
}

interface BotApps {
  apps: string[];
  appRules: Bot["appRules"];
}

function addApp(state: BotApps, entry: AppInputValue, context: ApplyContext): void {
  const slug = entry.app.trim().toLowerCase();
  if (!APP_SLUG.test(slug)) throw new Error(`"${entry.app}" isn't an app slug, like gmail.`);
  if (!state.apps.includes(slug)) state.apps.push(slug);
  const account = entry.account ? accountId(slug, entry.account, context) : null;
  const tools = entry.tools ?? "all";
  if (tools === "all" && !account) delete state.appRules[slug];
  else state.appRules[slug] = { tools, account };
}

function removeApp(state: BotApps, ref: string, botName: string): void {
  const slug = ref.trim().toLowerCase();
  const index = state.apps.indexOf(slug);
  if (index === -1) throw new Error(`${botName} doesn't use ${ref}.`);
  state.apps.splice(index, 1);
  delete state.appRules[slug];
}

export function withApps(
  bot: Bot,
  change: { add?: readonly AppInputValue[]; remove?: readonly string[] },
  context: ApplyContext,
): Bot {
  const state: BotApps = { apps: [...bot.apps], appRules: { ...bot.appRules } };
  for (const entry of change.add ?? []) addApp(state, entry, context);
  for (const ref of change.remove ?? []) removeApp(state, ref, bot.name);
  return { ...bot, apps: state.apps, appRules: state.appRules };
}

export function withGrants(bot: Bot, allow: readonly string[] = [], disallow: readonly string[] = []): Bot {
  const grants = new Set(bot.alwaysAllow);
  for (const grant of allow) {
    if (!TOOL_GRANT.test(grant.trim())) throw new Error(`"${grant}" isn't a tool as "server/tool".`);
    grants.add(grant.trim());
  }
  for (const grant of disallow) grants.delete(grant.trim());
  return { ...bot, alwaysAllow: [...grants] };
}

export function withPlaybooks(
  bot: Bot,
  add: readonly z.infer<typeof PlaybookInput>[] = [],
  remove: readonly string[] = [],
): Bot {
  let playbooks = [...bot.playbooks];
  const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  for (const ref of remove) {
    if (!playbooks.some((playbook) => same(playbook.name, ref)))
      throw new Error(`${bot.name} has no playbook called "${ref}".`);
    playbooks = playbooks.filter((playbook) => !same(playbook.name, ref));
  }
  for (const input of add) {
    const existing = playbooks.find((playbook) => same(playbook.name, input.name));
    const playbook = {
      id: existing?.id ?? newPlaybookId(),
      name: input.name.trim(),
      triggers: [...new Set(input.triggers.map((trigger) => trigger.trim()).filter(Boolean))],
      instructions: input.instructions.trim(),
    };
    playbooks = existing
      ? playbooks.map((entry) => (entry === existing ? playbook : entry))
      : [...playbooks, playbook];
  }
  return { ...bot, playbooks };
}

export function withBot(values: BotSettingsValues, bot: Bot, context: ApplyContext): BotSettingsValues {
  const previous = values.bots.find((entry) => entry.id === bot.id);
  const updated = { ...bot, updatedAt: context.now };
  return {
    ...values,
    bots: previous
      ? values.bots.map((entry) => (entry.id === bot.id ? updated : entry))
      : [...values.bots, updated],
    // Edits can be undone from the bot's History, as the user's own edits can.
    history: previous ? pushHistory(values.history, previous, new Date(context.now)) : values.history,
  };
}

export function uniqueBotName(values: BotSettingsValues, name: string, except?: string): string {
  const trimmed = oneLine(name);
  if (values.bots.some((bot) => bot.id !== except && bot.name.trim().toLowerCase() === trimmed.toLowerCase()))
    throw new Error(`There's already a bot called "${trimmed}".`);
  return trimmed;
}
