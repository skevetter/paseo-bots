import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  BotGroupSchema,
  BotSchema,
  BotStateSchema,
  ImportedBotSchema,
  ImportedSkillSchema,
  McpServerConfigSchema,
  McpToolSchema,
  SkillIdSchema,
  TeamFileTeamSchema,
} from "./bot";
import { ProposalSchema } from "./proposals";

const BotId = z.string().regex(/^[a-z0-9-]+$/);
/** "MEMORY.md" or a topic file such as "projects.md" (stored under memory/). */
export const MEMORY_FILE_NAME = /^[A-Za-z0-9 ._-]+\.md$/;
const MemoryFileName = z.string().regex(MEMORY_FILE_NAME);

/** `root` backs the Bots project, `path` the bot's workspace. */
export const ensureBotHomeRpc = defineRpc({
  name: "bots.ensure-home",
  input: z.object({ botId: BotId }),
  output: z.object({ root: z.string(), path: z.string() }),
});

/** Lets the daemon side start running routines. */
export const helloRpc = defineRpc({
  name: "bots.hello",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean() }),
});

export const stateReadRpc = defineRpc({
  name: "bots.state.read",
  input: z.object({}),
  output: z.object({ revision: z.string(), values: BotStateSchema }),
});

/** Saves only over `revision`; a newer one answers "conflict". */
export const stateWriteRpc = defineRpc({
  name: "bots.state.write",
  input: z.object({ revision: z.string(), values: BotStateSchema }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("saved"), revision: z.string(), values: BotStateSchema }),
    z.object({ status: z.literal("conflict"), error: z.string() }),
  ]),
});

const PromptSectionSchema = z.object({ title: z.string(), text: z.string() });

/** `message`, a new chat's first, picks the playbooks. */
export const systemPromptRpc = defineRpc({
  name: "bots.system-prompt",
  input: z.object({ bot: BotSchema, local: z.boolean(), message: z.string().max(100_000).optional() }),
  output: z.object({ systemPrompt: z.string(), sections: z.array(PromptSectionSchema) }),
});

const MemoryFileSchema = z.object({
  name: MemoryFileName,
  bytes: z.number(),
  lines: z.number(),
  topic: z.boolean(),
});

export const memoryListRpc = defineRpc({
  name: "bots.memory.list",
  input: z.object({ botId: BotId }),
  output: z.object({
    folder: z.string(),
    files: z.array(MemoryFileSchema),
    injectedLines: z.number(),
    injectedBytes: z.number(),
  }),
});

export const memoryReadRpc = defineRpc({
  name: "bots.memory.read",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ text: z.string() }),
});

export const memoryWriteRpc = defineRpc({
  name: "bots.memory.write",
  input: z.object({ botId: BotId, name: MemoryFileName, text: z.string().max(200_000) }),
  output: z.object({ ok: z.boolean() }),
});

export const memoryDeleteRpc = defineRpc({
  name: "bots.memory.delete",
  input: z.object({ botId: BotId, name: MemoryFileName }),
  output: z.object({ ok: z.boolean() }),
});

const LogDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** `text` is set when `day` is given. */
export const memoryLogRpc = defineRpc({
  name: "bots.memory.log",
  input: z.object({ botId: BotId, day: LogDay.optional() }),
  output: z.object({
    days: z.array(z.object({ day: z.string(), lines: z.number() })),
    text: z.string().nullable(),
  }),
});

export const memoryLogDeleteRpc = defineRpc({
  name: "bots.memory.log-delete",
  input: z.object({ botId: BotId, day: LogDay }),
  output: z.object({ ok: z.boolean() }),
});

const JournalEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  file: z.string(),
  actor: z.enum(["bot", "you"]),
  via: z.enum(["chat", "app", "disk", "undo"]),
  chat: z.object({ id: z.string(), title: z.string() }).nullable(),
  kind: z.enum(["created", "edited", "deleted"]),
  diff: z.string(),
  added: z.number(),
  removed: z.number(),
  canUndo: z.boolean(),
});
export type JournalRow = z.infer<typeof JournalEntrySchema>;

/** Newest first. */
export const memoryJournalRpc = defineRpc({
  name: "bots.memory.journal",
  input: z.object({ botId: BotId }),
  output: z.object({ entries: z.array(JournalEntrySchema) }),
});

export const memoryUndoRpc = defineRpc({
  name: "bots.memory.undo",
  input: z.object({ botId: BotId, id: z.string().regex(/^j-[a-z0-9]+$/) }),
  output: z.object({ ok: z.boolean() }),
});

/** `source`: "owner/repo", "owner/repo/path", a GitHub URL or a raw SKILL.md URL. */
export const skillImportRpc = defineRpc({
  name: "bots.library.import-skills",
  input: z.object({ source: z.string().min(1).max(500) }),
  output: z.object({ skills: z.array(ImportedSkillSchema) }),
});

export const skillReadRpc = defineRpc({
  name: "bots.library.read-skill",
  input: z.object({ id: SkillIdSchema }),
  output: z.object({
    text: z.string(),
    sha: z.string().nullable(),
    missing: z.boolean(),
    path: z.string(),
    files: z.array(z.string()),
  }),
});

export const skillWriteRpc = defineRpc({
  name: "bots.library.write-skill",
  input: z.object({ id: SkillIdSchema, text: z.string().max(256_000) }),
  output: z.object({ description: z.string(), sha: z.string() }),
});

export const skillDeleteRpc = defineRpc({
  name: "bots.library.delete-skill",
  input: z.object({ id: SkillIdSchema }),
  output: z.object({ ok: z.boolean() }),
});

export const mcpProbeRpc = defineRpc({
  name: "bots.library.test-mcp",
  input: z.object({ config: McpServerConfigSchema }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), tools: z.array(McpToolSchema) }),
    z.object({ ok: z.literal(false), error: z.string() }),
  ]),
});

export const mcpSourcesRpc = defineRpc({
  name: "bots.library.mcp-sources",
  input: z.object({}),
  output: z.object({
    sources: z.array(z.object({ label: z.string(), count: z.number(), json: z.string() })),
  }),
});

/** `keyHint`: only the key's last characters. */
export const avatarKeyStatusRpc = defineRpc({
  name: "bots.avatar.status",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), keyHint: z.string().nullable() }),
});

export const avatarSetKeyRpc = defineRpc({
  name: "bots.avatar.set-key",
  input: z.object({ key: z.string().min(1).max(400) }),
  output: z.object({ ok: z.boolean() }),
});

export const avatarRemoveKeyRpc = defineRpc({
  name: "bots.avatar.remove-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

/** Returns a WebP data URL. */
export const avatarGenerateRpc = defineRpc({
  name: "bots.avatar.generate",
  input: z.object({
    name: z.string().max(200),
    title: z.string().max(400),
    description: z.string().max(4000),
    direction: z.string().max(400),
  }),
  output: z.object({ image: z.string() }),
});

const RoutineRunSchema = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual", "webhook"]),
  /** When the run was due; for manual and webhook runs, when it was asked for. */
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped-busy", "skipped-missed"]),
  agentId: z.string().nullable(),
  /** The start of the bot's reply once the run finished. */
  output: z.string().nullable(),
  error: z.string().nullable(),
});
export type RoutineRun = z.infer<typeof RoutineRunSchema>;

/** A plugin timeline item, replaced (same id) when the run finishes. */
export const RoutineRunCardSchema = RoutineRunSchema.pick({
  trigger: true,
  scheduledFor: true,
  status: true,
  agentId: true,
  output: true,
  error: true,
}).extend({ routineName: z.string() });
export type RoutineRunCard = z.infer<typeof RoutineRunCardSchema>;
export const ROUTINE_RUN_CARD = { kind: "routine-run", version: 1 } as const;

const RoutineRecordSchema = z.object({
  /** The last time the schedule fired (runs, skips and misses), which the next due time counts from. */
  lastRunAt: z.string().nullable(),
  /** The latest runs, oldest first. */
  runs: z.array(RoutineRunSchema),
});
export type RoutineRecord = z.infer<typeof RoutineRecordSchema>;

export const routineStatusRpc = defineRpc({
  name: "bots.routines.status",
  input: z.object({}),
  output: z.object({ scheduler: z.boolean(), routines: z.record(z.string(), RoutineRecordSchema) }),
});

export const routineRunNowRpc = defineRpc({
  name: "bots.routines.run-now",
  input: z.object({ botId: BotId, routineId: z.string() }),
  output: z.object({ run: RoutineRunSchema }),
});

/** `rotate` replaces the secret so the old URL stops working. */
export const routineWebhookRpc = defineRpc({
  name: "bots.routines.webhook",
  input: z.object({ routineId: z.string().regex(/^[a-z0-9-]+$/), rotate: z.boolean().optional() }),
  output: z.object({ url: z.string() }),
});

/** Routines are exported paused, and secrets are redacted. */
export const exportBotRpc = defineRpc({
  name: "bots.export",
  input: z.object({ bot: BotSchema, includeMemory: z.boolean() }),
  output: z.object({ json: z.string() }),
});

/** Writes the bot's files for `botId`; the caller saves the returned bot and library additions. */
export const importBotRpc = defineRpc({
  name: "bots.import",
  input: z.object({ botId: BotId, json: z.string().max(5_000_000) }),
  output: ImportedBotSchema,
});

/** Secrets are redacted as in single exports. */
export const exportTeamRpc = defineRpc({
  name: "bots.export-team",
  input: z.object({
    bots: z.array(BotSchema).min(1).max(50),
    groups: z.array(BotGroupSchema).max(50).default([]),
    includeMemory: z.boolean(),
  }),
  output: z.object({ json: z.string() }),
});

/** Also accepts a single bot file. */
export const importTeamRpc = defineRpc({
  name: "bots.import-team",
  input: z.object({ json: z.string().max(20_000_000) }),
  output: z.object({ bots: z.array(ImportedBotSchema), teams: z.array(TeamFileTeamSchema) }),
});

/** Stored on this host so it can be sent as an `uploaded_file` attachment. */
export const uploadRpc = defineRpc({
  name: "bots.upload",
  input: z.object({
    botId: BotId,
    fileName: z.string().min(1).max(255),
    dataBase64: z.string().max(36_000_000),
  }),
  output: z.object({ path: z.string(), size: z.number() }),
});

const AppCardSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string(),
  logo: z.string().nullable(),
  domain: z.string().nullable(),
  noAuth: z.boolean(),
});
const AppAccountSchema = z.object({
  id: z.string(),
  slug: z.string(),
  status: z.enum(["connected", "pending", "failed"]),
  alias: z.string().nullable(),
  name: z.string().nullable(),
  wordId: z.string().nullable(),
});

export const APP_SIGN_IN_CARD = { kind: "app-sign-in", version: 1 } as const;
export const AppSignInSchema = z.object({
  slug: z.string(),
  url: z.string(),
  wordId: z.string().nullable(),
  alias: z.string().nullable(),
});
const Alias = z
  .string()
  .max(40)
  .regex(/^[\w .@+-]*$/, "Use letters, numbers, spaces, dots and dashes");
const AppSlug = z.string().regex(/^[a-z0-9_-]+$/);

/** `keyHint`: only the key's last characters. */
export const appsStatusRpc = defineRpc({
  name: "bots.apps.status",
  input: z.object({}),
  output: z.object({ configured: z.boolean(), keyHint: z.string().nullable() }),
});

/** Saved only after a session opens with it. */
export const appsSetKeyRpc = defineRpc({
  name: "bots.apps.set-key",
  input: z.object({ key: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

export const appsRemoveKeyRpc = defineRpc({
  name: "bots.apps.remove-key",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

export const appsCatalogRpc = defineRpc({
  name: "bots.apps.catalog",
  input: z.object({}),
  output: z.object({ apps: z.array(AppCardSchema) }),
});

export const appsAccountsRpc = defineRpc({
  name: "bots.apps.accounts",
  input: z.object({ fresh: z.boolean().optional() }),
  output: z.object({ accounts: z.array(AppAccountSchema) }),
});

export const appsConnectRpc = defineRpc({
  name: "bots.apps.connect",
  input: z.object({ slug: AppSlug, alias: Alias.optional() }),
  output: z.object({ url: z.string() }),
});

/** Unique per app; "" clears the name. */
export const appsRenameRpc = defineRpc({
  name: "bots.apps.rename",
  input: z.object({ accountId: z.string().min(1).max(200), alias: Alias }),
  output: z.object({ ok: z.boolean() }),
});

export const appsToolsRpc = defineRpc({
  name: "bots.apps.tools",
  input: z.object({ slug: AppSlug }),
  output: z.object({
    tools: z.array(z.object({ slug: z.string(), name: z.string(), readOnly: z.boolean() })),
  }),
});

export const appsDisconnectRpc = defineRpc({
  name: "bots.apps.disconnect",
  input: z.object({ accountId: z.string().min(1).max(200) }),
  output: z.object({ ok: z.boolean() }),
});

/** `agentId` is the chat's id, picked before the chat is created. */
export const mountRpc = defineRpc({
  name: "bots.mount",
  input: z.object({ botId: BotId, agentId: z.uuid() }),
  output: z.object({ tools: McpServerConfigSchema, apps: McpServerConfigSchema.nullable() }),
});

const ProposalId = z.string().regex(/^p-[a-z0-9]+$/);

/** Null once it's gone. */
export const proposalGetRpc = defineRpc({
  name: "bots.proposals.get",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema.nullable() }),
});

/** Newest first. */
export const proposalListRpc = defineRpc({
  name: "bots.proposals.list",
  input: z.object({
    status: z.enum(["pending", "accepted", "dismissed"]).optional(),
    origin: z.enum(["chat", "control"]).optional(),
  }),
  output: z.object({ proposals: z.array(ProposalSchema) }),
});

/** Applies the proposal to the bots, the library or the allowed commands, then marks it accepted. */
export const proposalAcceptRpc = defineRpc({
  name: "bots.proposals.accept",
  input: z.object({ id: ProposalId }),
  output: z.object({
    proposal: ProposalSchema,
    skill: z.object({ id: SkillIdSchema, description: z.string(), sha: z.string() }).optional(),
  }),
});

export const proposalDismissRpc = defineRpc({
  name: "bots.proposals.dismiss",
  input: z.object({ id: ProposalId }),
  output: z.object({ proposal: ProposalSchema }),
});

const CommandRuleSchema = z.object({ id: z.string(), command: z.string(), cwd: z.string() });

/** Matched exactly: command and folder. */
export const commandListRpc = defineRpc({
  name: "bots.commands.list",
  input: z.object({ botId: BotId }),
  output: z.object({ rules: z.array(CommandRuleSchema) }),
});

export const commandAllowRpc = defineRpc({
  name: "bots.commands.allow",
  input: z.object({
    botId: BotId,
    command: z.string().min(1).max(16_384),
    cwd: z.string().min(1).max(4_096),
  }),
  output: z.object({ rule: CommandRuleSchema }),
});

export const commandRemoveRpc = defineRpc({
  name: "bots.commands.remove",
  input: z.object({ botId: BotId, id: z.string() }),
  output: z.object({ ok: z.boolean() }),
});

/** No token: the app shows where the endpoint is; `command` is the stdio shim MCP clients start. */
export const controlStatusRpc = defineRpc({
  name: "bots.control.status",
  input: z.object({}),
  output: z.object({ url: z.string().nullable(), tokenFile: z.string(), command: z.string() }),
});

/** The old token stops working at once. */
export const controlRotateRpc = defineRpc({
  name: "bots.control.rotate",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});
