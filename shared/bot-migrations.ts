import { type BotMcpServer, BotMcpServerSchema, type Library, type LibraryMcpServer } from "./bot";
import { uniqueName } from "./bot-ids";
import { RESERVED_MCP_NAMES } from "./mcp-servers";

/** v1 kept `instructions` and `avatarSeed` flat. */
export function migrateV1(values: unknown): unknown {
  const bots = (values as { bots?: unknown[] } | null)?.bots ?? [];
  return {
    bots: bots.map((raw) => {
      const { instructions, avatarSeed, ...rest } = raw as Record<string, unknown>;
      return {
        ...rest,
        soul: instructions ?? "",
        avatar: { seed: typeof avatarSeed === "string" ? avatarSeed : "bot" },
      };
    }),
    history: [],
  };
}

type RawBot = Record<string, unknown> & { mcpServers?: unknown; skills?: unknown; alwaysAllow?: unknown };

interface MigrationTarget {
  library: Library;
  now: string;
}

function libraryServerFor(server: BotMcpServer, target: MigrationTarget): LibraryMcpServer {
  const { library, now } = target;
  const config = JSON.stringify(server.config);
  const found = library.mcpServers.find(
    (candidate) => candidate.name === server.name.trim() && JSON.stringify(candidate.config) === config,
  );
  if (found) return found;
  const taken = new Set([...RESERVED_MCP_NAMES, ...library.mcpServers.map((candidate) => candidate.name)]);
  const name = uniqueName(server.name.trim(), taken);
  const created: LibraryMcpServer = {
    id: `mcp-${name}`,
    name,
    description: "",
    enabled: true,
    config: server.config,
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
  library.mcpServers.push(created);
  return created;
}

function renameServerGrants(grants: string[], from: string, to: string): string[] {
  if (from === to) return grants;
  const prefix = `${from}/`;
  return grants.map((grant) => (grant.startsWith(prefix) ? `${to}/${grant.slice(prefix.length)}` : grant));
}

function migrateBotMcpServers(
  mcpServers: readonly unknown[],
  initialAllow: string[],
  target: MigrationTarget,
): { mcpServerIds: string[]; alwaysAllow: string[] } {
  const mcpServerIds: string[] = [];
  let alwaysAllow = initialAllow;
  for (const entry of mcpServers) {
    const parsed = BotMcpServerSchema.safeParse(entry);
    if (!parsed.success || !parsed.data.name.trim()) continue;
    const server = parsed.data;
    const found = libraryServerFor(server, target);
    alwaysAllow = renameServerGrants(alwaysAllow, server.name, found.name);
    if (server.enabled && !mcpServerIds.includes(found.id)) mcpServerIds.push(found.id);
  }
  return { mcpServerIds, alwaysAllow };
}

type RawSkill = { name?: unknown; description?: unknown; source?: unknown; enabled?: unknown };

function addLibrarySkill(id: string, skill: RawSkill, target: MigrationTarget): void {
  const { library, now } = target;
  if (library.skills.some((candidate) => candidate.id === id)) return;
  library.skills.push({
    id,
    description: typeof skill.description === "string" ? skill.description : "",
    source: typeof skill.source === "string" ? skill.source : "",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
}

function migrateBotSkills(skills: readonly unknown[], target: MigrationTarget): string[] {
  const skillIds: string[] = [];
  for (const entry of skills) {
    const skill = entry as RawSkill;
    if (typeof skill.name !== "string" || !skill.name) continue;
    addLibrarySkill(skill.name, skill, target);
    if (skill.enabled !== false && !skillIds.includes(skill.name)) skillIds.push(skill.name);
  }
  return skillIds;
}

/**
 * v2 kept MCP servers and skills on each bot. Ids derive from names so every
 * client migrating the same document agrees on them.
 */
export function migrateV2(values: unknown): unknown {
  const root = (values ?? {}) as { bots?: RawBot[]; history?: { snapshot?: RawBot }[] };
  const target: MigrationTarget = { library: { skills: [], mcpServers: [] }, now: new Date().toISOString() };

  const convert = (raw: RawBot): RawBot => {
    const { mcpServers, skills, ...rest } = raw;
    const initialAllow = Array.isArray(raw.alwaysAllow) ? (raw.alwaysAllow as string[]) : [];
    const { mcpServerIds, alwaysAllow } = migrateBotMcpServers(
      Array.isArray(mcpServers) ? mcpServers : [],
      initialAllow,
      target,
    );
    const skillIds = migrateBotSkills(Array.isArray(skills) ? skills : [], target);
    return { ...rest, alwaysAllow, mcpServerIds, skillIds };
  };

  return {
    ...root,
    bots: (root.bots ?? []).map(convert),
    history: (root.history ?? []).map((entry) =>
      entry.snapshot ? { ...entry, snapshot: convert(entry.snapshot) } : entry,
    ),
    library: target.library,
  };
}
