import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { z } from "zod";
import {
  type Bot,
  type BotGroup,
  type BotMcpServer,
  BotMcpServerSchema,
  BotSchema,
  type Library,
  type TeamFileTeam,
  TeamFileTeamSchema,
} from "../shared/bot";
import { botMcpServers, botSkills } from "../shared/bot-agent";
import { newBotId, newRoutineId } from "../shared/bot-ids";
import { teamMembers } from "../shared/groups";
import { sanitizeSkillName } from "../shared/skills";
import { botDataPath } from "./bot-home";
import { exists } from "./files";
import { type ImportedSkill, librarySkillPath } from "./library";

const FORMAT = "paseo-bots";
/** Files exported before the plugin was renamed. */
const FORMATS = z.enum([FORMAT, "paseo-bot"]);
const MAX_FILES = 400;

// Imports are bounded well past what this plugin exports, so only a crafted file trips them.
const MAX_IMPORT_FILES = 1_000;
const MAX_FILE_CHARS = 1_000_000;
const MAX_TEXT = 100_000;
const Line = z.string().max(4_000);
const Text = z.string().max(MAX_TEXT);

const routine = BotSchema.shape.routines.unwrap().element;
const playbook = BotSchema.shape.playbooks.unwrap().element;
const BotFields = z.object({
  name: z.string().max(200),
  title: Line.default(""),
  description: Line.default(""),
  avatar: BotSchema.shape.avatar.extend({
    seed: Line,
    imageUrl: z.string().max(500_000).nullable().default(null),
  }),
  soul: Text.default(""),
  provider: z.string().max(200),
  model: Line.nullable().default(null),
  modeId: Line.nullable().default(null),
  thinkingOptionId: Line.nullable().default(null),
  routines: z
    .array(routine.extend({ id: Line, name: Line, prompt: Text, createdAt: Line }))
    .max(100)
    .default([]),
  playbooks: z
    .array(
      playbook.extend({
        id: Line,
        name: Line,
        triggers: z.array(Line).max(50).default([]),
        instructions: Text,
      }),
    )
    .max(100)
    .default([]),
});

const SharedSkillSchema = z.object({
  id: Line,
  description: Line.default(""),
  source: Line.default(""),
});

const SharedServers = z.array(BotMcpServerSchema).max(50).default([]);
const SharedFiles = z.record(z.string().max(1_000), z.string().max(MAX_FILE_CHARS));

const ExportV2Schema = z.object({
  format: FORMATS,
  version: z.literal(2),
  bot: BotFields,
  skills: z.array(SharedSkillSchema).max(200).default([]),
  mcpServers: SharedServers,
  files: SharedFiles,
});

const ExportV1Schema = z.object({
  format: FORMATS,
  version: z.literal(1),
  bot: BotFields.extend({
    mcpServers: SharedServers,
    skills: z
      .array(
        z.object({
          name: Line,
          description: Line.default(""),
          source: Line.default(""),
          enabled: z.boolean().default(true),
        }),
      )
      .max(200)
      .default([]),
  }),
  files: SharedFiles,
});

/** Env values and headers can hold keys, so exports keep the names and drop the values. */
function redact(servers: BotMcpServer[]): BotMcpServer[] {
  const blank = (record: Record<string, string>) =>
    Object.fromEntries(Object.keys(record).map((key) => [key, "<redacted>"]));
  return servers.map((server) => ({
    ...server,
    config:
      server.config.type === "stdio"
        ? { ...server.config, env: blank(server.config.env) }
        : { ...server.config, headers: blank(server.config.headers) },
  }));
}

/** Links are skipped: they can dangle, loop, or point outside the folder being shared. */
async function collect(root: string, prefix: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (Object.keys(files).length >= MAX_FILES) return;
      await visit(entry, join(dir, entry.name));
    }
  };
  const visit = async (entry: Dirent, path: string) => {
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) await addFile(path);
  };
  const addFile = async (path: string) => {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null) files[`${prefix}/${relative(root, path).split(sep).join("/")}`] = text;
  };
  await walk(root);
  return files;
}

/** The bot folder is also the agent's working directory, so only the memory files are read. */
async function memoryFiles(botId: string): Promise<Record<string, string>> {
  const root = botDataPath(botId);
  const memory = await readFile(join(root, "MEMORY.md"), "utf8").catch(() => null);
  const notes = await collect(join(root, "memory"), "memory");
  return memory === null ? notes : { "MEMORY.md": memory, ...notes };
}

export async function exportBot(
  { bot, includeMemory }: { bot: Bot; includeMemory: boolean },
  library: Library,
) {
  const skills = botSkills(bot, library);
  const files: Record<string, string> = {};
  for (const skill of skills)
    Object.assign(files, await collect(librarySkillPath(skill.id), `skills/${skill.id}`));
  if (includeMemory) Object.assign(files, await memoryFiles(bot.id));
  const payload: z.input<typeof ExportV2Schema> = {
    format: FORMAT,
    version: 2,
    bot: {
      name: bot.name,
      title: bot.title,
      description: bot.description,
      avatar: bot.avatar,
      soul: bot.soul,
      provider: bot.provider,
      model: bot.model,
      modeId: bot.modeId,
      thinkingOptionId: bot.thinkingOptionId,
      // Results chats only exist on this host.
      routines: bot.routines.map((routine) => ({ ...routine, enabled: false, resultsChatId: null })),
      playbooks: bot.playbooks,
    },
    skills: skills.map((skill) => ({ id: skill.id, description: skill.description, source: skill.source })),
    mcpServers: redact(
      botMcpServers(bot, library).map((server) => ({
        name: server.name,
        enabled: true,
        config: server.config,
      })),
    ),
    files,
  };
  return { json: JSON.stringify(payload, null, 2) };
}

const NOT_AN_EXPORT = "That isn't a paseo-bots export.";
const TOO_BIG = "That export holds more than paseo-bots imports.";

function parseExport(json: string): z.infer<typeof ExportV2Schema> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error(NOT_AN_EXPORT);
  }
  const parsed = parseVersions(raw);
  if (Object.keys(parsed.files).length > MAX_IMPORT_FILES) throw new Error(TOO_BIG);
  return parsed;
}

function parseVersions(raw: unknown): z.infer<typeof ExportV2Schema> {
  const v2 = ExportV2Schema.safeParse(raw);
  if (v2.success) return v2.data;
  const v1 = ExportV1Schema.safeParse(raw);
  if (!v1.success) {
    const tooBig = [v2.error, v1.error].some((error) =>
      error.issues.some((issue) => issue.code === "too_big"),
    );
    throw new Error(tooBig ? TOO_BIG : NOT_AN_EXPORT);
  }
  const { mcpServers, skills, ...bot } = v1.data.bot;
  return {
    format: FORMAT,
    version: 2,
    bot,
    skills: skills
      .filter((skill) => skill.enabled)
      .map((skill) => ({ id: skill.name, description: skill.description, source: skill.source })),
    mcpServers: mcpServers.filter((server) => server.enabled),
    files: v1.data.files,
  };
}

function importTarget(path: string, root: string, fresh: Set<string>): string | null {
  // A backslash is a folder break on Windows, and no file system takes a NUL.
  if (path.includes("..") || /[\\\0]/.test(path)) return null;
  if (path === "MEMORY.md" || path.startsWith("memory/")) return join(root, ...path.split("/"));
  if (!path.startsWith("skills/")) return null;
  const [, id, ...rest] = path.split("/");
  const clean = id ? sanitizeSkillName(id) : "";
  return fresh.has(clean) && rest.length > 0 ? join(librarySkillPath(clean), ...rest) : null;
}

/** A skill already in the library is kept as is. */
export async function importBot({
  botId,
  json,
}: {
  botId: string;
  json: string;
}): Promise<{ bot: Bot; skills: ImportedSkill[]; mcpServers: BotMcpServer[] }> {
  const parsed = parseExport(json);
  const skills = parsed.skills.map((skill) => ({ ...skill, id: sanitizeSkillName(skill.id) }));
  const fresh = new Set<string>();
  for (const skill of skills) if (!(await exists(librarySkillPath(skill.id)))) fresh.add(skill.id);

  const root = botDataPath(botId);
  for (const [path, text] of Object.entries(parsed.files)) {
    const target = importTarget(path, root, fresh);
    if (!target) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text, "utf8");
  }
  const now = new Date().toISOString();
  const bot: Bot = {
    ...parsed.bot,
    id: botId,
    hostId: null,
    cwd: null,
    // Permissions start as on a new bot.
    modeId: null,
    alwaysAllow: [],
    skillIds: skills.map((skill) => skill.id),
    mcpServerIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    // Contact with other bots starts at asking, as on a new bot.
    contactBots: "ask",
    routines: parsed.bot.routines.map((routine) => ({
      ...routine,
      id: newRoutineId(),
      enabled: false,
      resultsChatId: null,
      createdAt: now,
    })),
    pinned: false,
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  return { bot, skills, mcpServers: parsed.mcpServers };
}

const TEAM_FORMAT = "paseo-bots-team";
const MAX_TEAM = 50;

const TeamSchema = z.object({
  format: z.literal(TEAM_FORMAT),
  version: z.literal(1),
  bots: z.array(z.unknown()).min(1).max(MAX_TEAM),
  teams: z.array(TeamFileTeamSchema).max(MAX_TEAM).default([]),
});

export function isTeamFile(json: string): boolean {
  try {
    return (JSON.parse(json) as { format?: unknown }).format === TEAM_FORMAT;
  } catch {
    return false;
  }
}

/** Teams point at bots by their index in the file. */
function teamsInFile(bots: readonly Bot[], groups: readonly BotGroup[]): TeamFileTeam[] {
  const index = new Map(bots.map((bot, position) => [bot.id, position]));
  return groups.flatMap((group) => {
    const members = teamMembers(group).flatMap((id) => index.get(id) ?? []);
    if (members.length === 0) return [];
    const lead = group.leadId ? (index.get(group.leadId) ?? null) : null;
    return [{ name: group.name, logo: group.logo, lead, members, instructions: group.instructions }];
  });
}

export async function exportTeam(
  { bots, groups, includeMemory }: { bots: Bot[]; groups: BotGroup[]; includeMemory: boolean },
  library: Library,
) {
  const shared = bots.slice(0, MAX_TEAM);
  const entries: unknown[] = [];
  for (const bot of shared) entries.push(JSON.parse((await exportBot({ bot, includeMemory }, library)).json));
  return {
    json: JSON.stringify(
      { format: TEAM_FORMAT, version: 1, bots: entries, teams: teamsInFile(shared, groups) },
      null,
      2,
    ),
  };
}

export async function importTeam({ json }: { json: string }) {
  if (!isTeamFile(json)) return { bots: [await importBot({ botId: newBotId(), json })], teams: [] };
  const parsed = TeamSchema.safeParse(JSON.parse(json));
  if (!parsed.success) throw new Error("That team file is damaged or from a newer version.");
  const bots = [];
  for (const entry of parsed.data.bots)
    bots.push(await importBot({ botId: newBotId(), json: JSON.stringify(entry) }));
  const inRange = (position: number) => position < bots.length;
  const teams = parsed.data.teams.map((team) => ({
    ...team,
    lead: team.lead !== null && inRange(team.lead) ? team.lead : null,
    members: team.members.filter(inRange),
  }));
  return { bots, teams };
}
