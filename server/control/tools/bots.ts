import { z } from "zod";
import {
  type Bot,
  type BotGroup,
  type BotState,
  DEFAULT_BOT_DEFAULTS,
  EMPTY_LIBRARY,
  type Library,
  type Preset,
} from "../../../shared/bot";
import { duplicateOf } from "../../../shared/bot-copy";
import { patchSavedBot } from "../../../shared/bot-history";
import { newBotId, numberedName } from "../../../shared/bot-ids";
import { isBrowserServer } from "../../../shared/browser";
import { startingBot } from "../../../shared/changes/bots";
import { describeChange } from "../../../shared/changes/describe";
import { botDetails } from "../../../shared/changes/overview";
import { findBot } from "../../../shared/changes/refs";
import { type Change, CreateBot, SetDefaults, UpdateBot } from "../../../shared/changes/schema";
import { elevations } from "../../../shared/elevated";
import { teamOf } from "../../../shared/groups";
import { applyContext } from "../../apply-context";
import { generateAvatar, imageStatus } from "../../images";
import { systemPrompt } from "../../prompt";
import { createProposal } from "../../proposals";
import { exportBot, importBot } from "../../share";
import type { ToolResult } from "../../tools/mcp";
import {
  applyOrPropose,
  BotRef,
  botByRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  needsApproval,
  pendingResult,
  result,
} from "../tool";

const PresetRef = z.string().min(1).max(100).describe("The preset's name or id.");

interface BotSummary {
  id: string;
  name: string;
  title: string;
  provider: string;
  model: string | null;
  mode: string | null;
  archived: boolean;
  pinned: boolean;
  team: string | null;
}

function botSummary(bot: Bot, groups: readonly BotGroup[] | undefined): BotSummary {
  return {
    id: bot.id,
    name: bot.name,
    title: bot.title,
    provider: bot.provider,
    model: bot.model,
    mode: bot.modeId,
    archived: bot.archived,
    pinned: bot.pinned,
    team: teamOf(bot.id, groups ?? [])?.name ?? null,
  };
}

function agentText(agent: { provider: string; model: string | null; mode: string | null }): string {
  return `${agent.provider || "any ready provider"}, model ${agent.model ?? "default"}, mode ${agent.mode ?? "default"}`;
}

function summaryLine(bot: BotSummary): string {
  const flags = [bot.team && `team ${bot.team}`, bot.pinned && "pinned", bot.archived && "archived"].filter(
    Boolean,
  );
  return `${bot.name} (id ${bot.id})${bot.title ? `, ${bot.title}` : ""}: ${agentText(bot)}${flags.length ? `; ${flags.join(", ")}` : ""}`;
}

function savedBot(values: BotState, botId: string, verb: string): ToolResult {
  const bot = values.bots.find((entry) => entry.id === botId);
  if (!bot) throw new Error("The bot was saved, then changed before it could be read back.");
  const summary = botSummary(bot, values.groups);
  return result(`${verb} ${summaryLine(summary)}`, { status: "applied", bot: summary });
}

async function changeBots(
  context: ControlContext,
  change: Change,
  done: (values: BotState) => ToolResult,
): Promise<ToolResult> {
  const outcome = await applyOrPropose(context, describeChange(change), [change]);
  return outcome.status === "pending" ? outcome.result : done(outcome.values);
}

const botsList = defineControlTool({
  name: "bots_list",
  description:
    "List the bots with their title, agent (provider, model, approval mode), team, and pinned and archived state.",
  input: z.object({
    include_archived: z.boolean().default(false).describe("Also list archived bots."),
  }),
  annotations: { readOnlyHint: true },
  async run({ include_archived }, context) {
    const values = await context.host.values();
    const bots = values.bots
      .filter((bot) => include_archived || !bot.archived)
      .map((bot) => botSummary(bot, values.groups));
    return result(bots.map(summaryLine).join("\n") || "There are no bots.", { bots });
  },
});

const botsGet = defineControlTool({
  name: "bots_get",
  description:
    "A bot's full settings, and the system prompt its next chat on this host starts with (as its Overview shows).",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot: ref }, context) {
    const values = await context.host.values();
    const bot = findBot(values, ref);
    const library = values.library ?? EMPTY_LIBRARY;
    const prompt = (await systemPrompt({ bot, local: true }, library, context.host.paseo, values))
      .systemPrompt;
    // Without Paseo the prompt can't check whether Paseo's tools are on for the provider.
    const note = context.host.paseo
      ? ""
      : "\n\n(Paseo isn't attached yet, so this assumes Paseo's tools are on.)";
    return result(`${botDetails(values, bot.id)}\n\nSystem prompt:\n${prompt}${note}`, {
      bot,
      team: teamOf(bot.id, values.groups ?? [])?.name ?? null,
      systemPrompt: prompt,
    });
  },
});

const CreateInput = CreateBot.omit({ type: true }).extend({
  name: CreateBot.shape.name.optional().describe("Defaults to the role's or preset's name, or New bot."),
});

const botsCreate = defineControlTool({
  name: "bots_create",
  description:
    "Create a bot, blank or from a role or a saved preset (presets_list), as New bot in the app does. It starts with the defaults' agent (defaults_get); the fields you give override the role or preset. An approval mode that runs without asking waits for approval.",
  input: CreateInput,
  async run({ name, ...fields }, context) {
    const values = await context.host.values();
    const start = startingBot(values, fields, "");
    const taken = new Set(values.bots.map((bot) => bot.name));
    const change: Change = { type: "create_bot", ...fields, name: name ?? numberedName(start.name, taken) };
    // A new bot is saved last.
    return changeBots(context, change, (saved) => savedBot(saved, saved.bots.at(-1)?.id ?? "", "Created"));
  },
});

const UpdateInput = UpdateBot.omit({
  type: true,
  add_skills: true,
  remove_skills: true,
  add_mcp_servers: true,
  remove_mcp_servers: true,
  add_apps: true,
  remove_apps: true,
})
  .extend({
    bot: BotRef,
    confirm: z.literal(true).optional().describe("Must be true to archive the bot."),
  })
  .refine((input) => input.archived !== true || input.confirm === true, {
    message: "Archiving needs confirm: true.",
    path: ["confirm"],
  });

const botsUpdate = defineControlTool({
  name: "bots_update",
  description:
    "Change a bot's settings, as its settings panel does. Earlier versions stay in its History (bots_history). An approval mode that runs without asking waits for approval.",
  input: UpdateInput,
  async run({ bot: ref, confirm: _confirm, ...fields }, context) {
    const { id } = await botByRef(context, ref);
    return changeBots(context, { type: "update_bot", bot: id, ...fields }, (values) =>
      savedBot(values, id, "Saved"),
    );
  },
});

const botsDuplicate = defineControlTool({
  name: "bots_duplicate",
  description:
    "Copy a bot, as its Duplicate menu item does: same settings, skills, MCP servers and permissions, a new face, paused routines and no memory. A copy that runs without asking or uses the Browser server waits for approval.",
  input: z.object({ bot: BotRef }),
  async run({ bot: ref }, context) {
    const bot = await botByRef(context, ref);
    const { json } = await exportBot({ bot, includeMemory: false }, await context.host.library());
    const copy = duplicateOf(bot, (await importBot({ botId: newBotId(), json })).bot);
    const values = await context.host.values();
    const added = (current: BotState) => ({ ...current, bots: [...current.bots, copy] });
    const reasons = elevations(values, added(values), (await applyContext(context.host)).modes);
    if (await needsApproval(context, reasons)) {
      const proposal = await createProposal({
        botId: "",
        agentId: "",
        origin: "control",
        kind: "import",
        data: {
          summary: `Duplicate ${bot.name}`,
          bots: [{ bot: copy, skills: [], mcpServers: [] }],
          teams: [],
        },
      });
      return pendingResult(proposal, reasons);
    }
    const saved = await context.host.store.update(added);
    return savedBot(saved.values, copy.id, `Duplicated ${bot.name} as`);
  },
});

const botsDelete = defineControlTool({
  name: "bots_delete",
  description: "Delete a bot and its History. Its chats stay on the host and in Paseo's history.",
  input: z.object({ bot: BotRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ bot: ref }, context) {
    const bot = await botByRef(context, ref);
    return changeBots(context, { type: "delete_bot", bot: bot.id }, () =>
      result(`Deleted ${bot.name}.`, { status: "applied", bot: { id: bot.id, name: bot.name } }),
    );
  },
});

const botsHistory = defineControlTool({
  name: "bots_history",
  description:
    "A bot's earlier versions, newest first, as History in its settings lists them. Each burst of edits keeps one.",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot: ref }, context) {
    const values = await context.host.values();
    const bot = findBot(values, ref);
    const versions = values.history
      .filter((entry) => entry.botId === bot.id)
      .reverse()
      .map((entry) => ({ at: entry.at, snapshot: entry.snapshot }));
    const lines = versions.map(
      ({ at, snapshot }) =>
        `- ${at}: ${snapshot.name}${snapshot.title ? `, ${snapshot.title}` : ""}; ${agentText({ ...snapshot, mode: snapshot.modeId })}`,
    );
    return result(
      lines.length
        ? `${bot.name}'s earlier versions:\n${lines.join("\n")}`
        : `${bot.name} has no earlier versions yet.`,
      {
        bot: bot.id,
        versions,
      },
    );
  },
});

/** As History's Restore saves it: the current version goes into History too. */
function withRestored(values: BotState, botId: string, snapshot: Bot): BotState {
  const current = values.bots.find((bot) => bot.id === botId);
  if (!current) throw new Error("That bot was deleted.");
  return patchSavedBot(values, current.id, snapshot, true);
}

/** The parts of a version that can need approval: its agent and any Browser server it adds back. */
function heldBack(current: Bot, snapshot: Bot, library: Library): { kept: Bot; change: Change } {
  const browser = new Set(library.mcpServers.filter(isBrowserServer).map((server) => server.id));
  const added = snapshot.mcpServerIds.filter((id) => browser.has(id) && !current.mcpServerIds.includes(id));
  const kept: Bot = {
    ...snapshot,
    provider: current.provider,
    model: current.model,
    modeId: current.modeId,
    thinkingOptionId: current.thinkingOptionId,
    mcpServerIds: snapshot.mcpServerIds.filter((id) => !added.includes(id)),
  };
  const change: Change = {
    type: "update_bot",
    bot: current.id,
    ...(snapshot.provider ? { provider: snapshot.provider } : {}),
    model: snapshot.model,
    mode: snapshot.modeId,
    thinking: snapshot.thinkingOptionId,
    ...(added.length ? { add_mcp_servers: added } : {}),
  };
  return { kept, change };
}

async function restoreWithApproval(
  context: ControlContext,
  current: Bot,
  version: { at: string; snapshot: Bot },
): Promise<ToolResult> {
  const { kept, change } = heldBack(current, version.snapshot, await context.host.library());
  const summary = `Finish restoring ${current.name}'s version from ${version.at}: its agent and MCP servers`;
  const outcome = await applyOrPropose(context, summary, [change]);
  const pending = outcome.status === "pending";
  const saved = await context.host.store.update((values) =>
    withRestored(values, current.id, pending ? kept : version.snapshot),
  );
  if (!pending) return savedBot(saved.values, current.id, `Restored the version from ${version.at}:`);
  return result(
    `Restored the version from ${version.at}, except its agent and MCP servers. ${outcome.result.text}`,
    { ...outcome.result.data, bot: current.id },
  );
}

const botsRestore = defineControlTool({
  name: "bots_restore",
  description:
    "Bring back one of a bot's earlier versions, as Restore in its History does; the current version stays in History. A version that runs without asking or uses the Browser server waits for approval for those parts.",
  input: z.object({
    bot: BotRef,
    at: z.string().min(1).max(100).describe("The version's time, from bots_history."),
  }),
  async run({ bot: ref, at }, context) {
    const values = await context.host.values();
    const bot = findBot(values, ref);
    const version = values.history.find((entry) => entry.botId === bot.id && entry.at === at);
    if (!version) throw new Error(`${bot.name} has no version from ${at}. bots_history lists them.`);
    const after = withRestored(values, bot.id, version.snapshot);
    const reasons = elevations(values, after, (await applyContext(context.host)).modes);
    if (await needsApproval(context, reasons)) return restoreWithApproval(context, bot, version);
    const saved = await context.host.store.update((current) =>
      withRestored(current, bot.id, version.snapshot),
    );
    return savedBot(saved.values, bot.id, `Restored the version from ${at}:`);
  },
});

function defaultsResult(values: BotState, status?: "applied"): ToolResult {
  const saved = values.defaults ?? DEFAULT_BOT_DEFAULTS;
  const defaults = {
    provider: saved.provider,
    model: saved.model,
    mode: saved.modeId,
    thinking: saved.thinkingOptionId,
    contactBots: saved.contactBots,
  };
  return result(
    `New bots start with ${agentText(defaults)}, thinking ${defaults.thinking ?? "default"}, contact with other bots: ${defaults.contactBots}.`,
    { ...(status ? { status } : {}), defaults },
  );
}

const defaultsGet = defineControlTool({
  name: "defaults_get",
  description: "The agent and contact setting new bots start with (Settings > Bots > New bots).",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_input, context) {
    return defaultsResult(await context.host.values());
  },
});

const defaultsSet = defineControlTool({
  name: "defaults_set",
  description:
    "Change what new bots start with. A model, mode or thinking level belongs to its provider. A mode that runs without asking waits for approval.",
  input: SetDefaults.omit({ type: true }),
  async run(fields, context) {
    return changeBots(context, { type: "set_defaults", ...fields }, (values) =>
      defaultsResult(values, "applied"),
    );
  },
});

interface PresetSummary {
  id: string;
  name: string;
  title: string;
  description: string;
  skills: string[];
  playbooks: string[];
  createdAt: string;
}

function presetView(preset: Preset): PresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    title: preset.title,
    description: preset.description,
    skills: preset.skillIds,
    playbooks: preset.playbooks.map((playbook) => playbook.name),
    createdAt: preset.createdAt,
  };
}

function presetLine(preset: PresetSummary): string {
  return `${preset.name} (id ${preset.id})${preset.title ? `, ${preset.title}` : ""}`;
}

const presetsList = defineControlTool({
  name: "presets_list",
  description:
    "The saved presets that New bot offers: who a bot is (name, title, blurb, face, instructions, playbooks, skills).",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_input, context) {
    const presets = ((await context.host.values()).presets ?? []).map(presetView);
    return result(presets.map(presetLine).join("\n") || "There are no presets.", { presets });
  },
});

const presetsSave = defineControlTool({
  name: "presets_save",
  description: "Save a bot as a preset, as its Save as preset menu item does. It shows under New bot.",
  input: z.object({ bot: BotRef }),
  async run({ bot: ref }, context) {
    const { id } = await botByRef(context, ref);
    return changeBots(context, { type: "save_preset", bot: id }, (values) => {
      const saved = values.presets?.at(-1);
      if (!saved) throw new Error("The preset was saved, then changed before it could be read back.");
      const preset = presetView(saved);
      return result(`Saved preset ${presetLine(preset)}.`, { status: "applied", preset });
    });
  },
});

const presetsDelete = defineControlTool({
  name: "presets_delete",
  description: "Delete a preset. Bots made from it stay.",
  input: z.object({ preset: PresetRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ preset }, context) {
    const before = new Set(((await context.host.values()).presets ?? []).map((entry) => entry.id));
    return changeBots(context, { type: "delete_preset", preset }, (values) => {
      const left = new Set((values.presets ?? []).map((entry) => entry.id));
      return result(`Deleted preset ${preset}.`, {
        status: "applied",
        deleted: [...before].filter((id) => !left.has(id)),
      });
    });
  },
});

const AvatarsInput = z
  .object({
    bot: BotRef.optional().describe("The bot to draw; the picture becomes its avatar."),
    name: z.string().min(1).max(100).optional().describe("Who to draw; defaults to the bot's name."),
    title: z.string().max(200).optional().describe("Defaults to the bot's title."),
    description: z.string().max(4000).optional().describe("Defaults to the bot's blurb."),
    direction: z
      .string()
      .max(400)
      .default("")
      .describe('Steers the picture, like "a calm owl librarian in flat colours".'),
  })
  .refine((input) => input.bot !== undefined || input.name !== undefined, "Give a bot or a name.");

const avatarsGenerate = defineControlTool({
  name: "avatars_generate",
  description:
    "Draw a bot picture with OpenAI's image model, as Generate a picture in a bot's Identity does. With a bot, the picture becomes its avatar; without one, it comes back as a WebP data URL in data.image.",
  input: AvatarsInput,
  async run({ bot: ref, name, title, description, direction }, context) {
    if (!(await imageStatus()).configured)
      throw new Error(
        "Generating a picture needs an OpenAI key. Add it in the app: a bot's settings > Identity > Generate a picture.",
      );
    const bot = ref ? await botByRef(context, ref) : null;
    const { image } = await generateAvatar({
      name: name ?? bot?.name ?? "",
      title: title ?? bot?.title ?? "",
      description: description ?? bot?.description ?? "",
      direction,
    });
    if (!bot) return result("Drew a picture. It's in data.image as a WebP data URL.", { image });
    return changeBots(context, { type: "update_bot", bot: bot.id, avatar: { image_url: image } }, (values) =>
      savedBot(values, bot.id, "Drew a new picture for"),
    );
  },
});

export const BOTS_TOOLS: readonly ControlTool[] = [
  botsList,
  botsGet,
  botsCreate,
  botsUpdate,
  botsDuplicate,
  botsDelete,
  botsHistory,
  botsRestore,
  defaultsGet,
  defaultsSet,
  presetsList,
  presetsSave,
  presetsDelete,
  avatarsGenerate,
];
