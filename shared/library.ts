import {
  type Bot,
  type BotMcpServer,
  type BotState,
  EMPTY_LIBRARY,
  type Library,
  type LibraryMcpServer,
  type LibrarySkill,
  type McpTool,
  type TeamFileTeam,
} from "./bot";
import { numberedName, uniqueName } from "./bot-ids";
import { isBrowserServer, withBrowserServer } from "./browser";
import { type ChangeIds, RANDOM_IDS } from "./changes/ids";
import { saveTeam } from "./groups";
import { joinArgs, MCP_NAME, RESERVED_MCP_NAMES } from "./mcp-servers";
import { PASEO_MCP_NAME } from "./paseo-tools";
import { type Policy, PolicySchema } from "./policies";
import { parseSkillFrontmatter } from "./skills";

export type LibraryKind = "skill" | "mcp";

type McpServerDraft = Pick<LibraryMcpServer, "name" | "description" | "config">;

export type LibraryMutation = (library: Library, bots: Bot[]) => { library?: Library; bots?: Bot[] };

/** Changes the library, with its built-in Browser entry, and the bots in one go. */
export function changeLibrary(values: BotState, mutate: LibraryMutation): BotState {
  const current = withBrowserServer(values.library ?? EMPTY_LIBRARY);
  const next = mutate(current, values.bots);
  return { ...values, library: next.library ?? current, bots: next.bots ?? values.bots };
}

/** Off until a test connects to it. */
export function newLibraryServer(
  draft: McpServerDraft,
  now: string = new Date().toISOString(),
  ids: ChangeIds = RANDOM_IDS,
): LibraryMcpServer {
  return {
    id: ids.id("mcp"),
    name: draft.name,
    description: draft.description,
    enabled: false,
    config: draft.config,
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function mcpServerNameError(name: string, otherNames: readonly string[]): string | null {
  if (!name) return null;
  if (!MCP_NAME.test(name)) return "Use letters, numbers, dashes and underscores";
  if (RESERVED_MCP_NAMES.includes(name))
    return `"${name}" is taken by ${name === PASEO_MCP_NAME ? "Paseo's own tools" : "connected apps"}`;
  return otherNames.includes(name) ? `"${name}" is already in the library` : null;
}

/** A changed connection makes the old test stale, so it needs a new one. */
export function editedServer(
  server: Pick<LibraryMcpServer, "config">,
  draft: McpServerDraft,
): { patch: Partial<LibraryMcpServer>; retest: boolean } {
  const retest = JSON.stringify(draft.config) !== JSON.stringify(server.config);
  const stale = retest ? { tools: null, checkError: null, checkedAt: null } : {};
  return {
    patch: { name: draft.name, description: draft.description, config: draft.config, ...stale },
    retest,
  };
}

export type McpTestResult = { ok: true; tools: McpTool[] } | { ok: false; error: string };

/** What a connection test records; `enable` turns the server on once it connects. */
export function testedServer(
  result: McpTestResult,
  enable = false,
  checkedAt: string = new Date().toISOString(),
): Partial<LibraryMcpServer> {
  return result.ok
    ? { tools: result.tools, checkError: null, checkedAt, ...(enable ? { enabled: true } : {}) }
    : { checkError: result.error, checkedAt };
}

/** `reuseByName` serves imports: a file's redacted copy of a server the user already set up adds nothing. */
export function addMcpServers(
  library: Library,
  drafts: readonly BotMcpServer[],
  options: { reuseByName?: boolean; now?: string; ids?: ChangeIds } = {},
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
    const server = newLibraryServer(
      {
        name: uniqueName(name, new Set([...RESERVED_MCP_NAMES, ...servers.map((entry) => entry.name)])),
        description: "",
        config: JSON.parse(JSON.stringify(draft.config)) as BotMcpServer["config"],
      },
      now,
      options.ids,
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

export function addedSkillsMessage(skills: readonly Pick<LibrarySkill, "id" | "reviewedSha">[]): string {
  const [first] = skills;
  const added = first && skills.length === 1 ? `Added ${first.id}` : `Added ${skills.length} skills`;
  const unreviewed = skills.filter((skill) => !skill.reviewedSha).length;
  if (!unreviewed) return added;
  const them = unreviewed === 1 ? "it" : "them";
  return `${added}. Review ${them} before bots use ${them}.`;
}

/** Imports stored as "github.com/owner/repo/path" update from "owner/repo/path"; links update from themselves. */
export function skillUpdateSource(source: string): string | null {
  if (source.startsWith("github.com/")) return source.slice("github.com/".length);
  return /^https?:\/\//i.test(source) ? source : null;
}

export function skillTextWarning(text: string, id: string): string | null {
  const meta = parseSkillFrontmatter(text);
  if (!meta.description) return "Add a description: line to the frontmatter so bots know when to use it";
  return meta.name && meta.name !== id ? `The name in the frontmatter should be "${id}"` : null;
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

export function withoutSkill(
  library: Library,
  bots: readonly Bot[],
  id: string,
): { library: Library; bots: Bot[] } {
  return {
    library: { ...library, skills: library.skills.filter((skill) => skill.id !== id) },
    bots: forgetItem(bots, "skill", id),
  };
}

/** Renames the server's grants along with it. */
export function patchedServer({
  library,
  bots,
  id,
  patch,
}: {
  library: Library;
  bots: Bot[];
  id: string;
  patch: Partial<LibraryMcpServer>;
}): { library: Library; bots: Bot[] } {
  const before = library.mcpServers.find((server) => server.id === id);
  const name = patch.name;
  const renamed = name !== undefined && before !== undefined && name !== before.name;
  return {
    library: updateMcpServer(library, id, patch),
    bots: renamed ? renameGrants(bots, before.name, name) : bots,
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
  policies?: readonly Policy[];
}

function withImportedPolicy(policies: Policy[], policy: Policy): Policy[] {
  const existing = policies.find((held) => held.id === policy.id && held.revision === policy.revision);
  if (existing) {
    const original = { ...PolicySchema.parse(existing), createdAt: null };
    const incoming = { ...PolicySchema.parse(policy), createdAt: null };
    if (JSON.stringify(original) !== JSON.stringify(incoming))
      throw new Error(`Imported policy ${policy.id} conflicts with an immutable revision.`);
    return policies;
  }
  return [...policies, policy];
}

function importedPolicies(values: BotState, imported: readonly ImportedBot[]): Policy[] | undefined {
  let policies = values.policies;
  for (const entry of imported)
    for (const policy of entry.policies ?? []) policies = withImportedPolicy(policies ?? [], policy);
  return policies;
}

export function addImportedBots(
  values: BotState,
  imported: readonly ImportedBot[],
  teams: readonly TeamFileTeam[] = [],
  { now = new Date().toISOString(), ids = RANDOM_IDS }: { now?: string; ids?: ChangeIds } = {},
): BotState {
  let library = values.library ?? EMPTY_LIBRARY;
  const bots = [...values.bots];
  for (const entry of imported) {
    const name = numberedName(entry.bot.name, new Set(bots.map((bot) => bot.name)));
    const known = new Set(library.skills.map((skill) => skill.id));
    library = upsertSkills(
      library,
      entry.skills.filter((skill) => !known.has(skill.id)),
    );
    // A file's servers wait in the library, off, for the user to attach; it never brings in a browser.
    const drafts = entry.mcpServers.filter((draft) => !isBrowserServer({ id: "", config: draft.config }));
    library = addMcpServers(library, drafts, { reuseByName: true, now, ids }).library;
    bots.push({ ...entry.bot, name });
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
    return memberIds.length ? saveTeam(current, { id: null, newId: ids.id("team"), draft, now }) : current;
  }, values.groups ?? []);
  const policies = importedPolicies(values, imported);
  return { ...values, bots, library, groups, ...(policies ? { policies } : {}) };
}
