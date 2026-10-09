import { z } from "zod";
import { randomSeed } from "./avatar";
import {
  type Bot,
  type BotAvatar,
  type BotDefaults,
  type BotGroup,
  type BotSettingsValues,
  DEFAULT_BOT_DEFAULTS,
  EMPTY_LIBRARY,
  type Library,
  MCP_NAME,
  type McpServerConfig,
  newGroupId,
  newPlaybookId,
  newRoutineId,
  presetFromBot,
  pushHistory,
  RESERVED_MCP_NAMES,
  type TeamLogo,
} from "./bot";
import { saveTeam, teamLogoOf, withoutBot } from "./groups";
import { addMcpServers, forgetItem, mcpServerTested, setBotUses } from "./library";
import { PALETTE_COUNT } from "./pixel";
import { describeSchedule, ScheduleInput, scheduleFrom } from "./routines";
import { BOT_TEMPLATES, newBot } from "./templates";

const Ref = (what: string) => z.string().min(1).max(100).describe(`${what}: its name or id.`);
const Ids = (what: string) => z.array(z.string().min(1).max(100)).max(100).describe(what);
const IMAGE_URL = /^(https?:\/\/\S+|data:image\/\S+)$/i;
const APP_SLUG = /^[a-z0-9_-]{1,60}$/i;
const TOOL_GRANT = /^[A-Za-z0-9_-]{1,64}\/\S{1,200}$/;

const Colour = z
  .number()
  .int()
  .min(0)
  .max(PALETTE_COUNT - 1)
  .nullable()
  .optional();
const ImageUrl = z
  .string()
  .max(2000)
  .nullable()
  .optional()
  .describe("An https:// picture shown instead of the pixel art; null removes it.");

const AvatarInput = z.object({
  new_face: z.boolean().optional().describe("Draw a different pixel-art face."),
  colour: Colour.describe(`Colour of the face, 0 to ${PALETTE_COUNT - 1}; null lets the face pick one.`),
  shape: z.enum(["circle", "rounded", "square"]).optional(),
  image_url: ImageUrl,
});

const LogoInput = z.object({
  new_logo: z.boolean().optional().describe("Draw a different pixel-art logo."),
  colour: Colour.describe(`Colour of the logo, 0 to ${PALETTE_COUNT - 1}; null lets the logo pick one.`),
  image_url: ImageUrl,
});

const PlaybookInput = z.object({
  name: z.string().min(1).max(80),
  triggers: z
    .array(z.string().min(1).max(60))
    .min(1)
    .max(20)
    .describe("Words or phrases that bring the playbook into a chat when its first message has one."),
  instructions: z.string().min(1).max(20_000),
});

const AppInput = z.object({
  app: z.string().min(1).max(60).describe("The connected app's slug, like gmail or slack."),
  tools: z
    .union([z.enum(["all", "read"]), z.array(z.string().min(1).max(200)).min(1).max(200)])
    .optional()
    .describe('Which of its tools: "all" (the default), "read" for the read-only ones, or exact tool names.'),
  account: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("The one account it must use, by its name; null or left out lets it pick."),
});

const BotFields = {
  title: z.string().max(200).optional().describe("One line: what the bot does."),
  description: z
    .string()
    .max(4000)
    .optional()
    .describe("Who the bot is; shown in the bot list and given to its agent."),
  instructions: z
    .string()
    .max(24_000)
    .optional()
    .describe("Standing instructions (its Soul). Replaces the current ones."),
  provider: z
    .string()
    .min(1)
    .max(60)
    .optional()
    .describe("Agent provider id from get_setup, like claude or codex."),
  model: z
    .string()
    .max(200)
    .nullable()
    .optional()
    .describe("Model id from get_setup; null for the provider's default."),
  mode: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Approval mode id from get_setup; null for the provider's default."),
  thinking: z
    .string()
    .max(100)
    .nullable()
    .optional()
    .describe("Thinking option id from get_setup; null for the default."),
  contact_bots: z
    .enum(["ask", "allow", "off"])
    .optional()
    .describe(
      "Asking other bots for help: after the user approves each request (ask), freely (allow) or never (off).",
    ),
  avatar: AvatarInput.optional(),
  working_folder: z
    .string()
    .max(1000)
    .nullable()
    .optional()
    .describe("Absolute path of its working folder; null for its own folder in the Bots project."),
  pinned: z.boolean().optional(),
};

const ROLE_IDS = BOT_TEMPLATES.map((template) => template.id) as [string, ...string[]];

const CreateBot = z.object({
  type: z.literal("create_bot"),
  name: z.string().min(1).max(100),
  role: z
    .enum(ROLE_IDS)
    .optional()
    .describe(
      `Start from a role (${BOT_TEMPLATES.map((template) => `${template.id}: ${template.title}`).join(", ")}); the other fields override it.`,
    ),
  ...BotFields,
  skills: Ids("Library skill ids to turn on.").optional(),
  mcp_servers: Ids("Library MCP servers to turn on, by name.").optional(),
  apps: z.array(AppInput).max(50).optional().describe("Connected apps it may use."),
  playbooks: z.array(PlaybookInput).max(20).optional(),
});

const UpdateBot = z.object({
  type: z.literal("update_bot"),
  bot: Ref("The bot"),
  name: z.string().min(1).max(100).optional(),
  ...BotFields,
  archived: z.boolean().optional(),
  add_skills: Ids("Library skill ids to turn on.").optional(),
  remove_skills: Ids("Skill ids to turn off.").optional(),
  add_mcp_servers: Ids("Library MCP servers to turn on, by name.").optional(),
  remove_mcp_servers: Ids("MCP servers to turn off, by name.").optional(),
  add_apps: z
    .array(AppInput)
    .max(50)
    .optional()
    .describe("Connected apps it may use, or new limits on ones it has."),
  remove_apps: Ids("App slugs it may no longer use.").optional(),
  allow_tools: Ids('MCP tools it may use without asking, as "server/tool".').optional(),
  disallow_tools: Ids('Tools to take off that list, as "server/tool".').optional(),
  add_playbooks: z
    .array(PlaybookInput)
    .max(20)
    .optional()
    .describe("Playbooks to add; one with the name of an existing playbook replaces it."),
  remove_playbooks: Ids("Playbooks to remove, by name.").optional(),
});

const DeleteBot = z.object({ type: z.literal("delete_bot"), bot: Ref("The bot") });

const AddRoutine = z.object({
  type: z.literal("add_routine"),
  bot: Ref("The bot that runs it"),
  name: z.string().min(1).max(80),
  instructions: z
    .string()
    .min(1)
    .max(20_000)
    .describe("What to do on each run, written so it works without this chat."),
  schedule: ScheduleInput,
});

const UpdateRoutine = z.object({
  type: z.literal("update_routine"),
  bot: Ref("The bot"),
  routine: Ref("The routine"),
  name: z.string().min(1).max(80).optional(),
  instructions: z.string().min(1).max(20_000).optional(),
  schedule: ScheduleInput.optional(),
  enabled: z.boolean().optional().describe("false pauses it."),
});

const DeleteRoutine = z.object({
  type: z.literal("delete_routine"),
  bot: Ref("The bot"),
  routine: Ref("The routine"),
});

const CreateTeam = z.object({
  type: z.literal("create_team"),
  name: z.string().min(1).max(60),
  lead: Ref("Its Chief of Staff, the user's main contact who hands work to the others").optional(),
  members: z
    .array(Ref("A member"))
    .max(50)
    .optional()
    .describe("The team's bots. A bot is on one team at a time; adding it moves it here."),
  instructions: z
    .string()
    .max(20_000)
    .optional()
    .describe("Shared instructions added to every member's prompt."),
  logo: LogoInput.optional(),
});

const UpdateTeam = z.object({
  type: z.literal("update_team"),
  team: Ref("The team"),
  name: z.string().min(1).max(60).optional(),
  lead: Ref("Its new Chief of Staff").nullable().optional().describe("Its Chief of Staff; null for none."),
  add_members: z.array(Ref("A bot")).max(50).optional(),
  remove_members: z.array(Ref("A bot")).max(50).optional(),
  instructions: z.string().max(20_000).optional().describe("Shared instructions; replaces the current ones."),
  logo: LogoInput.optional(),
});

const DeleteTeam = z.object({ type: z.literal("delete_team"), team: Ref("The team") });

const SetSkill = z.object({
  type: z.literal("set_skill"),
  skill: Ref("The library skill"),
  enabled: z.boolean().describe("Off keeps it in the library but out of every bot's prompt."),
});

const AddMcpServer = z.object({
  type: z.literal("add_mcp_server"),
  name: z.string().regex(MCP_NAME).describe("Letters, digits, - and _; what bots see before its tools."),
  description: z.string().max(300).optional(),
  command: z.string().min(1).max(1000).optional().describe("For a local server: the program to run."),
  args: z.array(z.string().max(1000)).max(50).optional(),
  env: z.record(z.string(), z.string().max(4000)).optional(),
  url: z.string().url().max(2000).optional().describe("For a remote server: its URL."),
  transport: z.enum(["http", "sse"]).optional().describe("For a remote server; http when left out."),
  headers: z.record(z.string(), z.string().max(4000)).optional(),
});

const SetMcpServer = z.object({
  type: z.literal("set_mcp_server"),
  server: Ref("The library MCP server"),
  enabled: z.boolean(),
});
const RemoveMcpServer = z.object({
  type: z.literal("remove_mcp_server"),
  server: Ref("The library MCP server"),
});

const SetDefaults = z.object({
  type: z.literal("set_defaults"),
  provider: z.string().max(60).optional().describe("Provider for new bots; empty picks one that's ready."),
  model: BotFields.model,
  mode: BotFields.mode,
  thinking: BotFields.thinking,
  contact_bots: BotFields.contact_bots,
});

const SavePreset = z.object({ type: z.literal("save_preset"), bot: Ref("The bot to save as a preset") });
const DeletePreset = z.object({ type: z.literal("delete_preset"), preset: Ref("The preset") });

export const ChangeSchema = z.discriminatedUnion("type", [
  CreateBot,
  UpdateBot,
  DeleteBot,
  AddRoutine,
  UpdateRoutine,
  DeleteRoutine,
  CreateTeam,
  UpdateTeam,
  DeleteTeam,
  SetSkill,
  AddMcpServer,
  SetMcpServer,
  RemoveMcpServer,
  SetDefaults,
  SavePreset,
  DeletePreset,
]);
export type Change = z.infer<typeof ChangeSchema>;
export const ChangesSchema = z.array(ChangeSchema).min(1).max(50);

type AppInputValue = z.infer<typeof AppInput>;
type BotFieldValues = { [Key in keyof typeof BotFields]?: z.infer<(typeof BotFields)[Key]> };

export interface ProviderInfo {
  id: string;
  models: { id: string; label: string; isDefault: boolean; thinking: string[] }[];
  modes: { id: string; label: string }[];
  defaultModeId: string | null;
}

export interface AppAccountInfo {
  id: string;
  slug: string;
  names: string[];
}

/** The fields of Paseo's provider snapshot entry that changes need. */
interface ProviderEntry {
  provider: string;
  enabled: boolean;
  status: string;
  models?: readonly {
    id: string;
    label: string;
    isDefault?: boolean;
    isSelectable?: boolean;
    thinkingOptions?: readonly { id: string }[];
  }[];
  modes?: readonly { id: string; label: string }[];
  defaultModeId?: string | null;
}

export function providerInfo(entries: readonly ProviderEntry[]): ProviderInfo[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.provider,
      models: (entry.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          id: model.id,
          label: model.label,
          isDefault: !!model.isDefault,
          thinking: (model.thinkingOptions ?? []).map((option) => option.id),
        })),
      modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
      defaultModeId: entry.defaultModeId ?? null,
    }));
}

export function readyProvider(entries: readonly ProviderEntry[]): string {
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
}

export interface ApplyContext {
  now: string;
  /** For new bots when neither the change nor the defaults name one. */
  provider: string;
  /** When known, provider, model, mode and thinking ids are checked against it. */
  providers?: readonly ProviderInfo[] | null;
  /** When known, app account names are resolved against it. */
  accounts?: readonly AppAccountInfo[] | null;
}

interface RefKind<T> {
  what: string;
  id: (item: T) => string;
  name: (item: T) => string;
}

function byRef<T>(items: readonly T[], ref: string, kind: RefKind<T>): T {
  const wanted = ref.trim();
  const exact = items.find((item) => kind.id(item) === wanted);
  if (exact) return exact;
  const key = wanted.toLowerCase();
  const named = items.filter((item) => kind.name(item).trim().toLowerCase() === key);
  const [only] = named;
  if (only && named.length === 1) return only;
  if (named.length > 1) throw new Error(`${named.length} ${kind.what}s are called "${wanted}". Use the id.`);
  const known = items.map(kind.name).filter(Boolean);
  throw new Error(
    `There's no ${kind.what} called "${wanted}".${known.length ? ` There are: ${known.slice(0, 30).join(", ")}.` : ""}`,
  );
}

const ROUTINE_REF: RefKind<Bot["routines"][number]> = {
  what: "routine",
  id: (routine) => routine.id,
  name: (routine) => routine.name,
};

const findBot = (values: BotSettingsValues, ref: string) =>
  byRef(values.bots, ref, { what: "bot", id: (bot) => bot.id, name: (bot) => bot.name });
const findTeam = (values: BotSettingsValues, ref: string) =>
  byRef(values.groups ?? [], ref, { what: "team", id: (group) => group.id, name: (group) => group.name });
const findSkill = (library: Library, ref: string) =>
  byRef(library.skills, ref, { what: "skill", id: (skill) => skill.id, name: (skill) => skill.id });
const findServer = (library: Library, ref: string) =>
  byRef(library.mcpServers, ref, {
    what: "MCP server",
    id: (server) => server.id,
    name: (server) => server.name,
  });

type ProviderModel = ProviderInfo["models"][number];

function checkModel(provider: ProviderInfo, modelId: string | null): ProviderModel | null {
  if (!modelId) return null;
  const model = provider.models.find((entry) => entry.id === modelId);
  if (!model)
    throw new Error(
      `${provider.id} has no model "${modelId}". Use one of: ${provider.models.map((entry) => entry.id).join(", ")}.`,
    );
  return model;
}

function checkThinking(
  provider: ProviderInfo,
  model: ProviderModel | null,
  thinkingOptionId: string | null,
): void {
  const thinking = (model ?? provider.models.find((entry) => entry.isDefault))?.thinking ?? [];
  if (thinkingOptionId && !thinking.includes(thinkingOptionId)) {
    throw new Error(
      `That model has no thinking option "${thinkingOptionId}". Use one of: ${thinking.join(", ") || "none"}.`,
    );
  }
}

function checkAgent(
  context: ApplyContext,
  fields: { provider: string; model: string | null; modeId: string | null; thinkingOptionId: string | null },
): void {
  const providers = context.providers;
  if (!providers || !fields.provider) return;
  const provider = providers.find((entry) => entry.id === fields.provider);
  if (!provider)
    throw new Error(
      `There's no provider "${fields.provider}". Use one of: ${providers.map((entry) => entry.id).join(", ")}.`,
    );
  const model = checkModel(provider, fields.model);
  if (fields.modeId && !provider.modes.some((mode) => mode.id === fields.modeId)) {
    throw new Error(
      `${provider.id} has no mode "${fields.modeId}". Use one of: ${provider.modes.map((mode) => mode.id).join(", ") || "none"}.`,
    );
  }
  checkThinking(provider, model, fields.thinkingOptionId);
}

function imageUrl(value: string | null): string | null {
  if (value !== null && !IMAGE_URL.test(value.trim()))
    throw new Error("A picture needs an https:// or data:image URL.");
  return value?.trim() ?? null;
}

function oneLine(text: string): string {
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

function withFields(bot: Bot, fields: BotFieldValues, context: ApplyContext): Bot {
  const next: Bot = withAgent({ ...bot, avatar: withAvatar(bot.avatar, fields.avatar) }, fields, context);
  if (fields.title !== undefined) next.title = oneLine(fields.title);
  if (fields.description !== undefined) next.description = fields.description.trim();
  if (fields.instructions !== undefined) next.soul = fields.instructions.trim();
  if (fields.contact_bots !== undefined) next.contactBots = fields.contact_bots;
  if (fields.working_folder !== undefined) next.cwd = workingFolder(fields.working_folder);
  if (fields.pinned !== undefined) next.pinned = fields.pinned;
  return next;
}

function withLibraryItems(
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

function withApps(
  bot: Bot,
  change: { add?: readonly AppInputValue[]; remove?: readonly string[] },
  context: ApplyContext,
): Bot {
  const state: BotApps = { apps: [...bot.apps], appRules: { ...bot.appRules } };
  for (const entry of change.add ?? []) addApp(state, entry, context);
  for (const ref of change.remove ?? []) removeApp(state, ref, bot.name);
  return { ...bot, apps: state.apps, appRules: state.appRules };
}

function accountId(slug: string, ref: string, context: ApplyContext): string {
  const accounts = context.accounts;
  // Proposals store the id once the host resolved it.
  if (!accounts) return ref;
  const mine = accounts.filter((account) => account.slug === slug);
  const key = ref.trim().toLowerCase();
  const found =
    mine.find((account) => account.id === ref.trim()) ??
    mine.find((account) => account.names.some((name) => name.toLowerCase() === key));
  if (!found)
    throw new Error(
      mine.length
        ? `${slug} has no account called "${ref}". Its accounts: ${mine.flatMap((account) => account.names.slice(0, 1)).join(", ")}.`
        : `${slug} isn't connected yet.`,
    );
  return found.id;
}

function withGrants(bot: Bot, allow: readonly string[] = [], disallow: readonly string[] = []): Bot {
  const grants = new Set(bot.alwaysAllow);
  for (const grant of allow) {
    if (!TOOL_GRANT.test(grant.trim())) throw new Error(`"${grant}" isn't a tool as "server/tool".`);
    grants.add(grant.trim());
  }
  for (const grant of disallow) grants.delete(grant.trim());
  return { ...bot, alwaysAllow: [...grants] };
}

function withPlaybooks(
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

function withBot(values: BotSettingsValues, bot: Bot, context: ApplyContext): BotSettingsValues {
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

function uniqueBotName(values: BotSettingsValues, name: string, except?: string): string {
  const trimmed = oneLine(name);
  if (values.bots.some((bot) => bot.id !== except && bot.name.trim().toLowerCase() === trimmed.toLowerCase()))
    throw new Error(`There's already a bot called "${trimmed}".`);
  return trimmed;
}

function withLogo(logo: TeamLogo, input: z.infer<typeof LogoInput> | undefined): TeamLogo {
  if (!input) return logo;
  return {
    seed: input.new_logo ? randomSeed() : logo.seed,
    palette: input.colour !== undefined ? input.colour : logo.palette,
    imageUrl:
      input.image_url !== undefined ? imageUrl(input.image_url) : input.new_logo ? null : logo.imageUrl,
  };
}

function teamMembers(group: BotGroup | null): string[] {
  return group ? [...new Set([...(group.leadId ? [group.leadId] : []), ...group.memberIds])] : [];
}

type ChangeOf<Type extends Change["type"]> = Extract<Change, { type: Type }>;

function createBot(
  values: BotSettingsValues,
  change: ChangeOf<"create_bot">,
  context: ApplyContext,
): BotSettingsValues {
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

function updateBot(
  values: BotSettingsValues,
  change: ChangeOf<"update_bot">,
  context: ApplyContext,
): BotSettingsValues {
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

function deleteBot(
  values: BotSettingsValues,
  change: ChangeOf<"delete_bot">,
  context: ApplyContext,
): BotSettingsValues {
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

function addRoutine(
  values: BotSettingsValues,
  change: ChangeOf<"add_routine">,
  context: ApplyContext,
): BotSettingsValues {
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

function updateRoutine(
  values: BotSettingsValues,
  change: ChangeOf<"update_routine">,
  context: ApplyContext,
): BotSettingsValues {
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

function deleteRoutine(
  values: BotSettingsValues,
  change: ChangeOf<"delete_routine">,
  context: ApplyContext,
): BotSettingsValues {
  const bot = findBot(values, change.bot);
  const routine = byRef(bot.routines, change.routine, ROUTINE_REF);
  return withBot(
    values,
    { ...bot, routines: bot.routines.filter((entry) => entry.id !== routine.id) },
    context,
  );
}

function createTeam(
  values: BotSettingsValues,
  change: ChangeOf<"create_team">,
  context: ApplyContext,
): BotSettingsValues {
  const lead = change.lead ? findBot(values, change.lead) : null;
  const members = [
    ...new Set([...(lead ? [lead.id] : []), ...(change.members ?? []).map((ref) => findBot(values, ref).id)]),
  ];
  const logo = withLogo({ seed: randomSeed(), palette: null, imageUrl: null }, change.logo);
  const draft = {
    name: oneLine(change.name),
    logo,
    leadId: lead?.id ?? null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? "",
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], { id: null, newId: newGroupId(), draft, now: context.now }),
  };
}

function updatedLead(
  values: BotSettingsValues,
  group: BotGroup,
  lead: string | null | undefined,
): string | null {
  if (lead === undefined) return group.leadId;
  return lead === null ? null : findBot(values, lead).id;
}

function updateTeam(
  values: BotSettingsValues,
  change: ChangeOf<"update_team">,
  context: ApplyContext,
): BotSettingsValues {
  const group = findTeam(values, change.team);
  const removed = new Set((change.remove_members ?? []).map((ref) => findBot(values, ref).id));
  const lead = updatedLead(values, group, change.lead);
  const kept = change.lead ? lead : null;
  const members = [
    ...new Set([
      ...teamMembers(group),
      ...(change.add_members ?? []).map((ref) => findBot(values, ref).id),
      ...(lead ? [lead] : []),
    ]),
  ].filter((id) => !removed.has(id) || id === kept);
  const draft = {
    name: change.name !== undefined ? oneLine(change.name) : group.name,
    logo: withLogo(teamLogoOf(group), change.logo),
    leadId: lead && members.includes(lead) ? lead : null,
    memberIds: members,
    instructions: change.instructions?.trim() ?? group.instructions,
  };
  return {
    ...values,
    groups: saveTeam(values.groups ?? [], { id: group.id, newId: group.id, draft, now: context.now }),
  };
}

function setSkill(
  values: BotSettingsValues,
  change: ChangeOf<"set_skill">,
  context: ApplyContext,
): BotSettingsValues {
  const library = values.library ?? EMPTY_LIBRARY;
  const skill = findSkill(library, change.skill);
  if (change.enabled && skill.reviewedSha === null)
    throw new Error(`${skill.id} needs a review before it can be on. The user reviews it in Skills & Tools.`);
  return {
    ...values,
    library: {
      ...library,
      skills: library.skills.map((entry) =>
        entry.id === skill.id ? { ...entry, enabled: change.enabled, updatedAt: context.now } : entry,
      ),
    },
  };
}

function mcpConfigFrom(change: ChangeOf<"add_mcp_server">): McpServerConfig {
  if (change.command && !change.url)
    return { type: "stdio", command: change.command.trim(), args: change.args ?? [], env: change.env ?? {} };
  if (change.url && !change.command)
    return { type: change.transport ?? "http", url: change.url.trim(), headers: change.headers ?? {} };
  throw new Error("Give either a command (a local server) or a URL (a remote one).");
}

function addMcpServer(
  values: BotSettingsValues,
  change: ChangeOf<"add_mcp_server">,
  context: ApplyContext,
): BotSettingsValues {
  const library = values.library ?? EMPTY_LIBRARY;
  const name = change.name.trim();
  if (RESERVED_MCP_NAMES.includes(name))
    throw new Error(`"${name}" is taken by Paseo or this plugin. Pick another name.`);
  if (library.mcpServers.some((server) => server.name === name))
    throw new Error(`There's already an MCP server called "${name}".`);
  const config = mcpConfigFrom(change);
  const added = addMcpServers(library, [{ name, enabled: true, config }], { now: context.now });
  const [id] = added.ids;
  return {
    ...values,
    library: {
      ...added.library,
      mcpServers: added.library.mcpServers.map((server) =>
        server.id === id ? { ...server, description: change.description?.trim() ?? "" } : server,
      ),
    },
  };
}

function setMcpServer(
  values: BotSettingsValues,
  change: ChangeOf<"set_mcp_server">,
  context: ApplyContext,
): BotSettingsValues {
  const library = values.library ?? EMPTY_LIBRARY;
  const server = findServer(library, change.server);
  if (change.enabled && !mcpServerTested(server))
    throw new Error(
      `${server.name} hasn't passed a connection test. The user tests it in Skills & Tools, which turns it on.`,
    );
  return {
    ...values,
    library: {
      ...library,
      mcpServers: library.mcpServers.map((entry) =>
        entry.id === server.id ? { ...entry, enabled: change.enabled, updatedAt: context.now } : entry,
      ),
    },
  };
}

function removeMcpServer(
  values: BotSettingsValues,
  change: ChangeOf<"remove_mcp_server">,
): BotSettingsValues {
  const library = values.library ?? EMPTY_LIBRARY;
  const server = findServer(library, change.server);
  return {
    ...values,
    library: { ...library, mcpServers: library.mcpServers.filter((entry) => entry.id !== server.id) },
    bots: forgetItem(values.bots, "mcp", server.id),
  };
}

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

const list = (items: readonly string[]) => items.join(", ");

function appText(entry: AppInputValue): string {
  const tools =
    !entry.tools || entry.tools === "all"
      ? ""
      : entry.tools === "read"
        ? " (read-only tools)"
        : ` (${list(entry.tools)})`;
  return `${entry.app}${tools}${entry.account ? " with one account" : ""}`;
}

function agentText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.provider !== undefined) parts.push(`provider ${fields.provider}`);
  if (fields.model !== undefined) parts.push(fields.model ? `model ${fields.model}` : "the default model");
  if (fields.mode !== undefined)
    parts.push(fields.mode ? `approval mode ${fields.mode}` : "the default approval mode");
  if (fields.thinking !== undefined)
    parts.push(fields.thinking ? `thinking ${fields.thinking}` : "default thinking");
  return parts;
}

function profileText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.title !== undefined) parts.push(`title "${oneLine(fields.title)}"`);
  if (fields.description !== undefined) parts.push("a new blurb");
  if (fields.instructions !== undefined) parts.push("new instructions");
  return parts;
}

function avatarText(avatar: z.infer<typeof AvatarInput>): string {
  if (avatar.image_url) return "a picture";
  return avatar.image_url === null ? "the pixel face back" : "a different face";
}

function settingsText(fields: BotFieldValues): string[] {
  const parts: string[] = [];
  if (fields.contact_bots !== undefined)
    parts.push(
      {
        ask: "asks before contacting other bots",
        allow: "contacts other bots freely",
        off: "doesn't contact other bots",
      }[fields.contact_bots],
    );
  if (fields.avatar) parts.push(avatarText(fields.avatar));
  if (fields.working_folder !== undefined)
    parts.push(fields.working_folder ? `working folder ${fields.working_folder}` : "its own working folder");
  if (fields.pinned !== undefined) parts.push(fields.pinned ? "pinned" : "unpinned");
  return parts;
}

function fieldsText(fields: BotFieldValues): string[] {
  return [...profileText(fields), ...agentText(fields), ...settingsText(fields)];
}

function scheduleText(input: z.infer<typeof ScheduleInput>): string {
  try {
    return describeSchedule(scheduleFrom(input, new Date()));
  } catch {
    return input.type;
  }
}

function listPart(label: string, items: readonly string[] | undefined, suffix = ""): string[] {
  return items?.length ? [`${label} ${list(items)}${suffix}`] : [];
}

function createBotText(change: ChangeOf<"create_bot">): string {
  const role = change.role
    ? [`starts as ${BOT_TEMPLATES.find((template) => template.id === change.role)?.title ?? change.role}`]
    : [];
  const parts = [
    ...role,
    ...fieldsText(change),
    ...listPart("skills", change.skills),
    ...listPart("MCP servers", change.mcp_servers),
    ...listPart("apps", change.apps?.map(appText)),
    ...listPart(
      "playbooks",
      change.playbooks?.map((playbook) => playbook.name),
    ),
  ];
  return `**New bot ${oneLine(change.name)}**${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function updateBotText(change: ChangeOf<"update_bot">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to ${oneLine(change.name)}`] : []),
    ...fieldsText(change),
    ...(change.archived !== undefined ? [change.archived ? "archived" : "unarchived"] : []),
    ...listPart("turns on skills", change.add_skills),
    ...listPart("turns off skills", change.remove_skills),
    ...listPart("turns on MCP servers", change.add_mcp_servers),
    ...listPart("turns off MCP servers", change.remove_mcp_servers),
    ...listPart("may use", change.add_apps?.map(appText)),
    ...listPart("no longer uses", change.remove_apps),
    ...listPart("uses", change.allow_tools, " without asking"),
    ...listPart("asks again before", change.disallow_tools),
    ...listPart(
      "playbooks",
      change.add_playbooks?.map((playbook) => playbook.name),
    ),
    ...listPart("removes playbooks", change.remove_playbooks),
  ];
  return `**${change.bot}**: ${parts.join("; ") || "no changes"}`;
}

function updateRoutineText(change: ChangeOf<"update_routine">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to "${change.name}"`] : []),
    ...(change.instructions !== undefined ? ["new instructions"] : []),
    ...(change.schedule ? [scheduleText(change.schedule)] : []),
    ...(change.enabled !== undefined ? [change.enabled ? "resumed" : "paused"] : []),
  ];
  return `**${change.bot}**: routine "${change.routine}" ${parts.join("; ") || "unchanged"}`;
}

function createTeamText(change: ChangeOf<"create_team">): string {
  const members = (change.members ?? []).filter((member) => member !== change.lead);
  const parts = [
    ...(change.lead ? [`led by ${change.lead}`] : []),
    ...listPart("with", members),
    ...(change.instructions?.trim() ? ["shared instructions"] : []),
  ];
  return `**New team ${oneLine(change.name)}**${parts.length ? `: ${parts.join("; ")}` : ""}`;
}

function updateTeamText(change: ChangeOf<"update_team">): string {
  const parts = [
    ...(change.name !== undefined ? [`renamed to ${oneLine(change.name)}`] : []),
    ...(change.lead !== undefined ? [change.lead ? `led by ${change.lead}` : "no Chief of Staff"] : []),
    ...listPart("adds", change.add_members),
    ...listPart("removes", change.remove_members),
    ...(change.instructions !== undefined ? ["new shared instructions"] : []),
    ...(change.logo ? ["a new logo"] : []),
  ];
  return `**Team ${change.team}**: ${parts.join("; ") || "no changes"}`;
}

function setDefaultsText(change: ChangeOf<"set_defaults">): string {
  const parts = [
    ...agentText(change),
    ...(change.contact_bots ? [`contact other bots: ${change.contact_bots}`] : []),
  ];
  return `**New bots start with** ${parts.join("; ") || "the same defaults"}`;
}

export function describeChange(change: Change): string {
  switch (change.type) {
    case "create_bot":
      return createBotText(change);
    case "update_bot":
      return updateBotText(change);
    case "delete_bot":
      return `**Delete bot ${change.bot}**; its chats stay in Paseo's history`;
    case "add_routine":
      return `**${change.bot}**: new routine "${change.name}", ${scheduleText(change.schedule)}`;
    case "update_routine":
      return updateRoutineText(change);
    case "delete_routine":
      return `**${change.bot}**: delete routine "${change.routine}"`;
    case "create_team":
      return createTeamText(change);
    case "update_team":
      return updateTeamText(change);
    case "delete_team":
      return `**Delete team ${change.team}**; its bots stay, without a team`;
    case "set_skill":
      return `**Skill ${change.skill}**: ${change.enabled ? "on" : "off"} for every bot that uses it`;
    case "add_mcp_server":
      return `**New MCP server ${change.name}**: ${change.command ? `runs \`${[change.command, ...(change.args ?? [])].join(" ")}\`` : `connects to ${change.url}`}; off until it passes a test in Skills & Tools`;
    case "set_mcp_server":
      return `**MCP server ${change.server}**: ${change.enabled ? "on" : "off"}`;
    case "remove_mcp_server":
      return `**Remove MCP server ${change.server}** from Skills & Tools and every bot`;
    case "set_defaults":
      return setDefaultsText(change);
    case "save_preset":
      return `**Save ${change.bot} as a preset**`;
    case "delete_preset":
      return `**Delete preset ${change.preset}**`;
  }
}

function botWarnings(change: ChangeOf<"create_bot"> | ChangeOf<"update_bot">): string[] {
  const who = change.type === "create_bot" ? change.name : change.bot;
  const warnings: string[] = [];
  if (change.mode) warnings.push(`${who} runs in approval mode "${change.mode}".`);
  if (change.contact_bots === "allow") warnings.push(`${who} may ask other bots without asking you.`);
  if (change.type === "update_bot" && change.allow_tools?.length)
    warnings.push(`${who} may use ${list(change.allow_tools)} without asking you.`);
  const apps = change.type === "create_bot" ? change.apps : change.add_apps;
  if (apps?.length)
    warnings.push(`${who} may use ${list(apps.map((entry) => entry.app))} with your connected accounts.`);
  if (change.working_folder) warnings.push(`${who} works in ${change.working_folder}.`);
  return warnings;
}

function changeWarning(change: Change): string[] {
  switch (change.type) {
    case "create_bot":
    case "update_bot":
      return botWarnings(change);
    case "add_mcp_server":
      return change.command
        ? [`The ${change.name} MCP server runs a program on this computer once it's on.`]
        : [];
    case "delete_bot":
      return [`Deletes the bot ${change.bot}.`];
    case "delete_team":
      return [`Deletes the team ${change.team}.`];
    case "remove_mcp_server":
      return [`Removes the MCP server ${change.server}.`];
    default:
      return [];
  }
}

export function changeWarnings(changes: readonly Change[]): string[] {
  return changes.flatMap((change) => changeWarning(change));
}

function teamPart(bot: Bot, groups: readonly BotGroup[]): string | null {
  const team = groups.find((group) => group.leadId === bot.id || group.memberIds.includes(bot.id));
  if (!team) return null;
  return `team ${team.name}${team.leadId === bot.id ? " (Chief of Staff)" : ""}`;
}

function usesParts(bot: Bot, library: Library): (string | null)[] {
  const servers = bot.mcpServerIds.map(
    (id) => library.mcpServers.find((server) => server.id === id)?.name ?? id,
  );
  const routines = bot.routines.length;
  return [
    bot.skillIds.length ? `skills ${list(bot.skillIds)}` : null,
    servers.length ? `MCP servers ${list(servers)}` : null,
    bot.apps.length ? `apps ${list(bot.apps)}` : null,
    routines ? `${routines} routine${routines === 1 ? "" : "s"}` : null,
  ];
}

function botLine(bot: Bot, values: BotSettingsValues): string {
  const parts = [
    [bot.provider || "no provider", bot.model ?? "default model", bot.modeId ? `mode ${bot.modeId}` : null]
      .filter(Boolean)
      .join(" · "),
    teamPart(bot, values.groups ?? []),
    ...usesParts(bot, values.library ?? EMPTY_LIBRARY),
    `contact other bots: ${bot.contactBots}`,
    bot.archived ? "archived" : null,
  ].filter(Boolean);
  return `- ${bot.name} (id ${bot.id})${bot.title ? `: ${bot.title}` : ""}. ${parts.join("; ")}.`;
}

function teamsSection(groups: readonly BotGroup[], names: ReadonlyMap<string, string>): string {
  const lines = groups.map((group) => {
    const members = teamMembers(group)
      .filter((id) => id !== group.leadId)
      .map((id) => names.get(id) ?? id);
    const lead = group.leadId ? (names.get(group.leadId) ?? group.leadId) : "none";
    return `- ${group.name} (id ${group.id}): Chief of Staff ${lead}; members ${list(members) || "none"}${group.instructions.trim() ? "; has shared instructions" : ""}.`;
  });
  return `Teams (${groups.length}):\n${lines.join("\n") || "- none"}`;
}

function skillsSection(skills: Library["skills"]): string {
  const lines = skills.map((skill) => {
    const state = skill.reviewedSha === null ? "needs review" : skill.enabled ? "on" : "off";
    return `- ${skill.id}: ${skill.description || "no description"} [${state}]`;
  });
  return `Library skills (${skills.length}):\n${lines.join("\n") || "- none"}`;
}

function serversSection(servers: Library["mcpServers"]): string {
  const lines = servers.map((server) => {
    const state = server.enabled ? "on" : mcpServerTested(server) ? "off" : "off, untested";
    return `- ${server.name}${server.description ? `: ${server.description}` : ""} [${state}]`;
  });
  return `Library MCP servers (${servers.length}):\n${lines.join("\n") || "- none"}`;
}

function appsSection(apps: readonly AppAccountInfo[] | null): string {
  if (!apps) return "Connected apps: not set up.";
  const lines = [...new Set(apps.map((account) => account.slug))].map(
    (slug) =>
      `- ${slug}: accounts ${list(apps.filter((account) => account.slug === slug).map((account) => account.names[0] ?? account.id))}`,
  );
  return `Connected apps:\n${lines.join("\n") || "- none"}`;
}

function providersSection(providers: readonly ProviderInfo[] | null): string {
  if (!providers) return "Providers: unknown right now.";
  const lines = providers.map((provider) => {
    const models = list(
      provider.models.map(
        (model) =>
          `${model.id}${model.isDefault ? " (default)" : ""}${model.thinking.length ? ` [thinking: ${list(model.thinking)}]` : ""}`,
      ),
    );
    const modes = list(
      provider.modes.map((mode) => `${mode.id}${mode.id === provider.defaultModeId ? " (default)" : ""}`),
    );
    return `- ${provider.id}: models ${models || "none"}; modes ${modes || "none"}`;
  });
  return `Providers:\n${lines.join("\n")}`;
}

export function setupOverview(
  values: BotSettingsValues,
  providers: readonly ProviderInfo[] | null,
  apps: readonly AppAccountInfo[] | null,
): string {
  const library = values.library ?? EMPTY_LIBRARY;
  const defaults = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const byId = new Map(values.bots.map((bot) => [bot.id, bot.name]));
  const sections = [
    `Bots (${values.bots.length}):\n${values.bots.map((bot) => botLine(bot, values)).join("\n") || "- none"}`,
    teamsSection(values.groups ?? [], byId),
    skillsSection(library.skills),
    serversSection(library.mcpServers),
    appsSection(apps),
    `New bots start with: provider ${defaults.provider || "any ready one"}, ${defaults.model ?? "default model"}, contact other bots: ${defaults.contactBots}.`,
    `Presets: ${list((values.presets ?? []).map((preset) => preset.name)) || "none"}.`,
    providersSection(providers),
    `Roles for new bots: ${list(BOT_TEMPLATES.map((template) => `${template.id} (${template.title})`))}.`,
  ];
  return sections.join("\n\n");
}

export function botDetails(values: BotSettingsValues, ref: string): string {
  const bot = findBot(values, ref);
  const library = values.library ?? EMPTY_LIBRARY;
  const block = (title: string, text: string) => `${title}:\n${text.trim() || "(none)"}`;
  return [
    botLine(bot, values),
    block("Blurb", bot.description),
    block("Instructions (Soul)", bot.soul),
    block(
      "Playbooks",
      bot.playbooks
        .map(
          (playbook) =>
            `- ${playbook.name} (triggers: ${list(playbook.triggers)}):\n${playbook.instructions}`,
        )
        .join("\n\n"),
    ),
    block(
      "Routines",
      bot.routines
        .map(
          (routine) =>
            `- ${routine.name} (id ${routine.id}, ${routine.enabled ? describeSchedule(routine.schedule) : "paused"}):\n${routine.prompt}`,
        )
        .join("\n\n"),
    ),
    block(
      "MCP servers",
      bot.mcpServerIds
        .map((id) => library.mcpServers.find((server) => server.id === id)?.name ?? id)
        .join(", "),
    ),
    block("Tools allowed without asking", bot.alwaysAllow.join(", ")),
    block(
      "Connected apps",
      bot.apps
        .map((slug) => {
          const rule = bot.appRules[slug];
          return `${slug}${rule ? ` (tools: ${Array.isArray(rule.tools) ? list(rule.tools) : rule.tools}${rule.account ? "; one account" : ""})` : ""}`;
        })
        .join(", "),
    ),
    block("Working folder", bot.cwd ?? "its own folder in the Bots project"),
  ].join("\n\n");
}
