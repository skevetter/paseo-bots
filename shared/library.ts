import {
  type Bot,
  type BotMcpServer,
  type BotSettingsValues,
  EMPTY_LIBRARY,
  type Library,
  type LibraryMcpServer,
  type LibrarySkill,
  type TeamFileTeam,
} from "./bot";
import { newGroupId, numberedName, uniqueName } from "./bot-ids";
import { saveTeam } from "./groups";
import { joinArgs, RESERVED_MCP_NAMES } from "./mcp-servers";

export function newMcpServerId(): string {
  return `mcp-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export type LibraryKind = "skill" | "mcp";

/** Off until a test connects to it. */
function libraryServer(draft: BotMcpServer, name: string, now: string): LibraryMcpServer {
  return {
    id: newMcpServerId(),
    name,
    description: "",
    enabled: false,
    config: JSON.parse(JSON.stringify(draft.config)) as BotMcpServer["config"],
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** `reuseByName` serves templates: the user may have filled in keys since. */
export function addMcpServers(
  library: Library,
  drafts: readonly BotMcpServer[],
  options: { reuseByName?: boolean; now?: string } = {},
): { library: Library; ids: string[] } {
  const now = options.now ?? new Date().toISOString();
  const servers = [...library.mcpServers];
  const ids: string[] = [];
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const config = JSON.stringify(draft.config);
    const existing = servers.find(
      (server) => server.name === name && (options.reuseByName || JSON.stringify(server.config) === config),
    );
    if (existing) {
      ids.push(existing.id);
      continue;
    }
    const server = libraryServer(
      draft,
      uniqueName(name, new Set([...RESERVED_MCP_NAMES, ...servers.map((entry) => entry.name)])),
      now,
    );
    servers.push(server);
    ids.push(server.id);
  }
  return { library: { ...library, mcpServers: servers }, ids };
}

/**
 * Fetched skills arrive off and unreviewed, and a refresh needs a new review; a
 * skill written here carries the hash of what the user wrote and arrives on.
 */
export function upsertSkills(
  library: Library,
  skills: readonly (Pick<LibrarySkill, "id" | "description" | "source"> & { reviewedSha?: string })[],
  now: string = new Date().toISOString(),
): Library {
  const next = [...library.skills];
  for (const { reviewedSha, ...skill } of skills) {
    const index = next.findIndex((entry) => entry.id === skill.id);
    const existing = next[index];
    if (!existing)
      next.push({
        ...skill,
        enabled: !!reviewedSha,
        reviewedSha: reviewedSha ?? null,
        createdAt: now,
        updatedAt: now,
      });
    else
      next[index] = {
        ...existing,
        description: skill.description,
        source: skill.source || existing.source,
        reviewedSha: reviewedSha ?? null,
        updatedAt: now,
      };
  }
  return { ...library, skills: next };
}

export function updateMcpServer(library: Library, id: string, patch: Partial<LibraryMcpServer>): Library {
  return {
    ...library,
    mcpServers: library.mcpServers.map((server) =>
      server.id === id ? { ...server, ...patch, updatedAt: new Date().toISOString() } : server,
    ),
  };
}

export function updateSkill(library: Library, id: string, patch: Partial<LibrarySkill>): Library {
  return {
    ...library,
    skills: library.skills.map((skill) =>
      skill.id === id ? { ...skill, ...patch, updatedAt: new Date().toISOString() } : skill,
    ),
  };
}

export function setBotUses(bot: Bot, kind: LibraryKind, id: string, on: boolean): Bot {
  const key = kind === "skill" ? "skillIds" : "mcpServerIds";
  const current = bot[key];
  const next = on
    ? current.includes(id)
      ? current
      : [...current, id]
    : current.filter((entry) => entry !== id);
  return next === current ? bot : { ...bot, [key]: next };
}

export function forgetItem(bots: readonly Bot[], kind: LibraryKind, id: string): Bot[] {
  return bots.map((bot) => setBotUses(bot, kind, id, false));
}

/** Takes a server out of the library and off every bot, with the tools it let them run without asking. */
export function withoutMcpServer(
  library: Library,
  bots: readonly Bot[],
  id: string,
): { library: Library; bots: Bot[] } {
  const removed = library.mcpServers.find((server) => server.id === id);
  const prefix = `${removed?.name}/`;
  return {
    library: { ...library, mcpServers: library.mcpServers.filter((server) => server.id !== id) },
    bots: forgetItem(bots, "mcp", id).map((bot) =>
      removed && bot.alwaysAllow.some((grant) => grant.startsWith(prefix))
        ? { ...bot, alwaysAllow: bot.alwaysAllow.filter((grant) => !grant.startsWith(prefix)) }
        : bot,
    ),
  };
}

export function renameGrants(bots: readonly Bot[], from: string, to: string): Bot[] {
  if (from === to) return [...bots];
  const prefix = `${from}/`;
  return bots.map((bot) =>
    bot.alwaysAllow.some((grant) => grant.startsWith(prefix))
      ? {
          ...bot,
          alwaysAllow: bot.alwaysAllow.map((grant) =>
            grant.startsWith(prefix) ? `${to}/${grant.slice(prefix.length)}` : grant,
          ),
        }
      : bot,
  );
}

/** Only a server whose last test connected can be turned on. */
export function mcpServerTested(server: Pick<LibraryMcpServer, "tools" | "checkError">): boolean {
  return server.tools !== null && !server.checkError;
}

export function mcpTarget(config: BotMcpServer["config"]): string {
  return config.type === "stdio"
    ? [config.command, joinArgs(config.args)].filter(Boolean).join(" ")
    : `${config.type.toUpperCase()} · ${config.url}`;
}

export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || fields.some((field) => field?.toLowerCase().includes(needle));
}

export interface ImportedBot {
  bot: Bot;
  skills: readonly Pick<LibrarySkill, "id" | "description" | "source">[];
  mcpServers: readonly BotMcpServer[];
}

export function addImportedBots(
  values: BotSettingsValues,
  imported: readonly ImportedBot[],
  teams: readonly TeamFileTeam[] = [],
  now: string = new Date().toISOString(),
): BotSettingsValues {
  let library = values.library ?? EMPTY_LIBRARY;
  const bots = [...values.bots];
  for (const entry of imported) {
    const name = numberedName(entry.bot.name, new Set(bots.map((bot) => bot.name)));
    const known = new Set(library.skills.map((skill) => skill.id));
    library = upsertSkills(
      library,
      entry.skills.filter((skill) => !known.has(skill.id)),
    );
    const added = addMcpServers(library, entry.mcpServers, { reuseByName: true });
    library = added.library;
    bots.push({ ...entry.bot, name, mcpServerIds: [...new Set([...entry.bot.mcpServerIds, ...added.ids])] });
  }
  const idAt = (position: number) => imported[position]?.bot.id;
  const groups = teams.reduce((current, team) => {
    const memberIds = team.members.flatMap((position) => idAt(position) ?? []);
    const draft = {
      name: team.name,
      logo: team.logo,
      leadId: team.lead === null ? null : (idAt(team.lead) ?? null),
      memberIds,
      instructions: team.instructions,
    };
    return memberIds.length ? saveTeam(current, { id: null, newId: newGroupId(), draft, now }) : current;
  }, values.groups ?? []);
  return { ...values, bots, library, groups };
}
