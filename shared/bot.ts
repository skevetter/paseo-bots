import { z } from "zod";

/** Chats are found by filtering agents on this label. */
export const BOT_LABEL = "paseo-bots.bot";

const StringRecord = z.record(z.string(), z.string());

export const McpServerConfigSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: StringRecord.default({}),
  }),
  z.object({ type: z.literal("http"), url: z.string(), headers: StringRecord.default({}) }),
  z.object({ type: z.literal("sse"), url: z.string(), headers: StringRecord.default({}) }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

export const BotMcpServerSchema = z.object({
  name: z.string(),
  enabled: z.boolean().default(true),
  config: McpServerConfigSchema,
});
export type BotMcpServer = z.infer<typeof BotMcpServerSchema>;

const BotAvatarSchema = z.object({
  seed: z.string(),
  /** Null lets the seed pick. */
  palette: z.number().int().nullable().default(null),
  shape: z.enum(["circle", "rounded", "square"]).default("circle"),
  /** An http(s) or data: image shown instead of the generated face. */
  imageUrl: z.string().nullable().default(null),
});
export type BotAvatar = z.infer<typeof BotAvatarSchema>;

/** `id` is the folder name and the name bots see. */
const LibrarySkillSchema = z.object({
  id: z.string(),
  description: z.string().default(""),
  /** Where it came from: "github.com/owner/repo/path", a SKILL.md link, or "" when written here. */
  source: z.string().default(""),
  /** Off keeps it in the library but out of every bot's prompt. */
  enabled: z.boolean().default(true),
  /**
   * SHA-256 of the SKILL.md the user reviewed; bots get the skill only while the
   * file still matches. Null: never reviewed. Absent: added before reviews existed.
   */
  reviewedSha: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LibrarySkill = z.infer<typeof LibrarySkillSchema>;

export function skillNeedsReview(
  skill: Pick<LibrarySkill, "reviewedSha">,
  currentSha?: string | null,
): boolean {
  if (skill.reviewedSha === undefined) return false;
  if (skill.reviewedSha === null) return true;
  return !!currentSha && currentSha !== skill.reviewedSha;
}

export const McpToolSchema = z.object({ name: z.string(), description: z.string().default("") });
export type McpTool = z.infer<typeof McpToolSchema>;

/** `name` is the key agents see ("server/tool"). */
const LibraryMcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().default(""),
  /** Off keeps it in the library but away from every bot. */
  enabled: z.boolean().default(true),
  config: McpServerConfigSchema,
  /** What the server listed at the last connection test. */
  tools: z.array(McpToolSchema).nullable().default(null),
  checkedAt: z.string().nullable().default(null),
  checkError: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LibraryMcpServer = z.infer<typeof LibraryMcpServerSchema>;

const LibrarySchema = z.object({
  skills: z.array(LibrarySkillSchema).default([]),
  mcpServers: z.array(LibraryMcpServerSchema).default([]),
});
export type Library = z.infer<typeof LibrarySchema>;
export const EMPTY_LIBRARY: Library = { skills: [], mcpServers: [] };

export const RoutineScheduleSchema = z.discriminatedUnion("kind", [
  /** Local time "HH:MM" on the given weekdays (0 = Sunday). */
  z.object({
    kind: z.literal("daily"),
    time: z.string().regex(/^\d{2}:\d{2}$/),
    weekdays: z.array(z.number().int().min(0).max(6)).default([0, 1, 2, 3, 4, 5, 6]),
  }),
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(1440) }),
  z.object({ kind: z.literal("once"), at: z.string() }),
  /** Five-field cron in the host's local time. */
  z.object({ kind: z.literal("cron"), expression: z.string() }),
  z.object({ kind: z.literal("webhook") }),
]);
export type RoutineSchedule = z.infer<typeof RoutineScheduleSchema>;

const RoutineSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  enabled: z.boolean().default(true),
  schedule: RoutineScheduleSchema,
  /** Gets a card for each run; runs themselves always get their own chat. */
  resultsChatId: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type Routine = z.infer<typeof RoutineSchema>;

/** Applies when a trigger word appears in a chat's first message. */
const PlaybookSchema = z.object({
  id: z.string(),
  name: z.string(),
  triggers: z.array(z.string()).default([]),
  instructions: z.string(),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

/**
 * `"read"`: the tools Composio marks read-only. `account`: a Composio account
 * id; null lets the bot pick one by name.
 */
const AppRuleSchema = z.object({
  tools: z.union([z.enum(["all", "read"]), z.array(z.string())]).default("all"),
  account: z.string().nullable().default(null),
});
export type AppRule = z.infer<typeof AppRuleSchema>;

/** `name` is a device voice; voices differ per device. */
const BotVoiceSchema = z.object({
  name: z.string().nullable().default(null),
  readReplies: z.boolean().default(false),
});
export type BotVoice = z.infer<typeof BotVoiceSchema>;

export const BotSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().default(""),
  description: z.string().default(""),
  avatar: BotAvatarSchema,
  /** Daemon server id; null means the host that stores the bot. */
  hostId: z.string().nullable().default(null),
  provider: z.string(),
  model: z.string().nullable().default(null),
  /** Paseo mode: the provider's approval level. */
  modeId: z.string().nullable().default(null),
  thinkingOptionId: z.string().nullable().default(null),
  /** Standing instructions, placed right after the persona in the system prompt. */
  soul: z.string().default(""),
  mcpServerIds: z.array(z.string()).default([]),
  /** Exact MCP tool grants ("server/tool"). */
  alwaysAllow: z.array(z.string()).default([]),
  skillIds: z.array(z.string()).default([]),
  /** Composio toolkit slugs. */
  apps: z.array(z.string()).default([]),
  /** An app without a rule allows every tool and account. */
  appRules: z.record(z.string(), AppRuleSchema).default({}),
  voice: BotVoiceSchema.default({ name: null, readReplies: false }),
  /** ask: the user approves each request; allow: freely; off: never. */
  contactBots: z.enum(["ask", "allow", "off"]).default("ask"),
  routines: z.array(RoutineSchema).default([]),
  playbooks: z.array(PlaybookSchema).default([]),
  /** Null means the shared managed folder on the storing host. */
  cwd: z.string().nullable().default(null),
  pinned: z.boolean().default(false),
  archived: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Bot = z.infer<typeof BotSchema>;

const HistoryEntrySchema = z.object({ botId: z.string(), at: z.string(), snapshot: BotSchema });
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const BotListUiSchema = z.object({
  collapsed: z.array(z.string()).default([]),
  pinnedCollapsed: z.boolean().default(false),
  /** In pin order. */
  pinnedChats: z.array(z.object({ botId: z.string(), chatId: z.string() })).default([]),
  chatOrder: z.record(z.string(), z.array(z.string())).default({}),
  chatSort: z.enum(["manual", "activity"]).default("manual"),
  showArchived: z.boolean().default(false),
  /** A team id, or OTHER_BOTS_TAB. Null opens the first. */
  tab: z.string().nullable().default(null),
  listWidth: z.number().default(320),
  panelWidth: z.number().default(320),
});
export type BotListUi = z.infer<typeof BotListUiSchema>;

export const DEFAULT_BOT_LIST_UI: BotListUi = BotListUiSchema.parse({});

const TeamLogoSchema = z.object({
  seed: z.string(),
  /** Null lets the seed pick. */
  palette: z.number().int().nullable().default(null),
  /** An http(s) or data: image shown instead of the generated logo. */
  imageUrl: z.string().nullable().default(null),
});
export type TeamLogo = z.infer<typeof TeamLogoSchema>;

export const BotGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** Null draws a logo from the team's id. */
  logo: TeamLogoSchema.nullable().default(null),
  /** Hands work to the others; null until one is picked. */
  leadId: z.string().nullable().default(null),
  /** Includes the lead. */
  memberIds: z.array(z.string()).default([]),
  /** Added to every member's prompt; only the user edits it. */
  instructions: z.string().default(""),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotGroup = z.infer<typeof BotGroupSchema>;

/** `lead` and `members` index the file's list of bots. */
export const TeamFileTeamSchema = z.object({
  name: z.string().max(60),
  logo: TeamLogoSchema.nullable().default(null),
  lead: z.number().int().min(0).nullable().default(null),
  members: z.array(z.number().int().min(0)).max(50).default([]),
  instructions: z.string().max(20_000).default(""),
});
export type TeamFileTeam = z.infer<typeof TeamFileTeamSchema>;

/** Matches sanitizeSkillName: a leading dot would name "." or ".." instead of a skill folder. */
export const SkillIdSchema = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);

export const ImportedSkillSchema = z.object({
  id: SkillIdSchema,
  description: z.string(),
  source: z.string(),
});

export const ImportedBotSchema = z.object({
  bot: BotSchema,
  skills: z.array(ImportedSkillSchema),
  mcpServers: z.array(BotMcpServerSchema),
});

/** An empty provider picks one that's ready. */
const BotDefaultsSchema = z.object({
  provider: z.string().default(""),
  model: z.string().nullable().default(null),
  modeId: z.string().nullable().default(null),
  thinkingOptionId: z.string().nullable().default(null),
  contactBots: z.enum(["ask", "allow", "off"]).default("ask"),
});
export type BotDefaults = z.infer<typeof BotDefaultsSchema>;
export const DEFAULT_BOT_DEFAULTS: BotDefaults = BotDefaultsSchema.parse({});

/** Who a bot is and how it works; access, routines and the agent come from the defaults. */
const PresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().default(""),
  description: z.string().default(""),
  avatar: BotAvatarSchema,
  soul: z.string().default(""),
  playbooks: z.array(PlaybookSchema).default([]),
  skillIds: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Preset = z.infer<typeof PresetSchema>;

export const BotStateSchema = z.object({
  bots: z.array(BotSchema).default([]),
  history: z.array(HistoryEntrySchema).default([]),
  ui: BotListUiSchema.optional(),
  library: LibrarySchema.optional(),
  defaults: BotDefaultsSchema.optional(),
  presets: z.array(PresetSchema).optional(),
  groups: z.array(BotGroupSchema).optional(),
});
export type BotState = z.infer<typeof BotStateSchema>;

export interface StateSnapshot {
  revision: string;
  values: BotState;
}
