import { z } from "zod";
import { MCP_NAME } from "../bot";
import { PALETTE_COUNT } from "../pixel";
import { ScheduleInput } from "../routines";
import { BOT_TEMPLATES } from "../templates";

const Ref = (what: string) => z.string().min(1).max(100).describe(`${what}: its name or id.`);
const Ids = (what: string) => z.array(z.string().min(1).max(100)).max(100).describe(what);

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

export const AvatarInput = z.object({
  new_face: z.boolean().optional().describe("Draw a different pixel-art face."),
  colour: Colour.describe(`Colour of the face, 0 to ${PALETTE_COUNT - 1}; null lets the face pick one.`),
  shape: z.enum(["circle", "rounded", "square"]).optional(),
  image_url: ImageUrl,
});

export const LogoInput = z.object({
  new_logo: z.boolean().optional().describe("Draw a different pixel-art logo."),
  colour: Colour.describe(`Colour of the logo, 0 to ${PALETTE_COUNT - 1}; null lets the logo pick one.`),
  image_url: ImageUrl,
});

export const PlaybookInput = z.object({
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

export type AppInputValue = z.infer<typeof AppInput>;
export type BotFieldValues = { [Key in keyof typeof BotFields]?: z.infer<(typeof BotFields)[Key]> };

export type ChangeOf<Type extends Change["type"]> = Extract<Change, { type: Type }>;
