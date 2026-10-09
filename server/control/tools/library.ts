import { z } from "zod";
import { plural } from "../../../shared/activity";
import {
  type Bot,
  type BotState,
  EMPTY_LIBRARY,
  type Library,
  type LibraryMcpServer,
  type LibrarySkill,
  type McpServerConfig,
  skillNeedsReview,
} from "../../../shared/bot";
import {
  BROWSER_SERVER_ID,
  isBrowserServer,
  mcpServerLabel,
  withBrowserServer,
} from "../../../shared/browser";
import { describeChange } from "../../../shared/changes/describe";
import { findBot, findServer, findSkill } from "../../../shared/changes/refs";
import type { Change } from "../../../shared/changes/schema";
import {
  addedSkillsMessage,
  addMcpServers,
  changeLibrary,
  editedServer,
  type LibraryMutation,
  type McpTestResult,
  mcpServerNameError,
  mcpServerTested,
  mcpTarget,
  patchedServer,
  skillTextWarning,
  skillUpdateSource,
  testedServer,
  updateMcpServer,
  updateSkill,
  upsertSkills,
  withoutMcpServer,
  withoutSkill,
} from "../../../shared/library";
import { MCP_NAME, parseMcpJson } from "../../../shared/mcp-servers";
import { sanitizeSkillName, scanSkillText } from "../../../shared/skills";
import { deleteSkill, importSkills, readSkill, skillSha, writeSkill } from "../../library";
import { probeMcpServer } from "../../mcp-probe";
import { mcpSources } from "../../mcp-sources";
import type { ToolResult } from "../../tools/mcp";
import {
  APPROVAL_PLACE,
  applyOrPropose,
  BotRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  MASK,
  maskedConfig,
  result,
} from "../tool";

const ServerRef = z.string().min(1).max(100).describe("The MCP server's name or id.");
const SkillRef = z.string().min(1).max(100).describe("The skill's id.");
const ServerName = z
  .string()
  .regex(MCP_NAME)
  .describe("Letters, digits, - and _; what bots see before its tools, as in fetch/get.");
const Pairs = z.record(z.string().min(1).max(200), z.string().max(4000));
const ConfigInput = z
  .union([
    z
      .object({
        command: z.string().min(1).max(1000).describe("The program to run on this host."),
        args: z.array(z.string().max(1000)).max(50).optional(),
        env: Pairs.optional().describe(`Environment variables. "${MASK}" keeps a value already set.`),
      })
      .strict(),
    z
      .object({
        url: z
          .string()
          .max(2000)
          .regex(/^https?:\/\/\S+$/i, "Use an http:// or https:// URL"),
        transport: z.enum(["http", "sse"]).optional().describe("http when left out."),
        headers: Pairs.optional().describe(`HTTP headers. "${MASK}" keeps a value already set.`),
      })
      .strict(),
  ])
  .describe("A local server (command, args, env) or a remote one (url, transport, headers).");
type ConfigInputValue = z.infer<typeof ConfigInput>;

async function saveLibrary(context: ControlContext, mutate: LibraryMutation): Promise<BotState> {
  return (await context.host.store.update((values) => changeLibrary(values, mutate))).values;
}

/** The library as the app shows it, with its built-in Browser entry. */
async function shownLibrary(context: ControlContext): Promise<{ values: BotState; library: Library }> {
  const values = await context.host.values();
  return { values, library: withBrowserServer(values.library ?? EMPTY_LIBRARY) };
}

// MCP servers

interface NamedBot {
  id: string;
  name: string;
}

interface ServerView extends Omit<LibraryMcpServer, "createdAt" | "updatedAt"> {
  label: string;
  tested: boolean;
  browser: boolean;
  target: string;
  bots: NamedBot[];
}

function serverView(server: LibraryMcpServer, bots: readonly Bot[]): ServerView {
  return {
    id: server.id,
    name: server.name,
    label: mcpServerLabel(server),
    description: server.description,
    enabled: server.enabled,
    tested: mcpServerTested(server),
    browser: isBrowserServer(server),
    target: mcpTarget(server.config),
    config: maskedConfig(server.config),
    tools: server.tools,
    checkedAt: server.checkedAt,
    checkError: server.checkError,
    bots: bots.filter((bot) => bot.mcpServerIds.includes(server.id)).map(({ id, name }) => ({ id, name })),
  };
}

function serverLine(view: ServerView): string {
  const state = view.enabled ? "on" : view.tested ? "off" : "off, untested";
  const bots = view.bots.map((bot) => bot.name).join(", ") || "no bots";
  return `${view.label} (${view.id}): ${state}; ${view.target}; used by ${bots}.`;
}

async function serverById(context: ControlContext, id: string): Promise<ServerView> {
  const { values, library } = await shownLibrary(context);
  return serverView(findServer(library, id), values.bots);
}

/** `stored` is null once the target changed: then a masked value no longer stands for the stored one. */
function keptValues(
  next: Record<string, string>,
  stored: Record<string, string> | null,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(next).map(([key, value]) => {
      if (value !== MASK) return [key, value];
      const known = stored?.[key];
      if (known === undefined)
        throw new Error(
          stored
            ? `${key} has no value yet; give it one.`
            : `${key} needs its value again for the new target.`,
        );
      return [key, known];
    }),
  );
}

function storedValues(current: McpServerConfig, target: McpServerConfig): Record<string, string> | null {
  if (current.type === "stdio" && target.type === "stdio")
    return current.command === target.command && JSON.stringify(current.args) === JSON.stringify(target.args)
      ? current.env
      : null;
  if (current.type !== "stdio" && target.type === current.type && current.url === target.url)
    return current.headers;
  return null;
}

/** Clients only ever see env and header values masked, so a masked one keeps what's set while the target stays. */
function configFrom(input: ConfigInputValue, current?: McpServerConfig): McpServerConfig {
  const target: McpServerConfig =
    "command" in input
      ? { type: "stdio", command: input.command.trim(), args: input.args ?? [], env: input.env ?? {} }
      : { type: input.transport ?? "http", url: input.url.trim(), headers: input.headers ?? {} };
  const stored = current ? storedValues(current, target) : {};
  return target.type === "stdio"
    ? { ...target, env: keptValues(target.env, stored) }
    : { ...target, headers: keptValues(target.headers, stored) };
}

function addServerChange(server: Pick<LibraryMcpServer, "name" | "description" | "config">): Change {
  const { name, description, config } = server;
  return config.type === "stdio"
    ? {
        type: "add_mcp_server",
        name,
        description,
        command: config.command,
        args: config.args,
        env: config.env,
      }
    : {
        type: "add_mcp_server",
        name,
        description,
        url: config.url,
        transport: config.type,
        headers: config.headers,
      };
}

/** A server added from outside the app runs a program or reaches a URL, so it waits for the user. */
function addServerReason({ name, config }: Pick<LibraryMcpServer, "name" | "config">): string {
  const target =
    config.type === "stdio"
      ? `runs \`${[config.command, ...config.args].join(" ")}\``
      : `connects to ${config.url}`;
  return `Adds the MCP server ${name}, which ${target} on this computer.`;
}

async function addServers(
  context: ControlContext,
  servers: readonly Pick<LibraryMcpServer, "name" | "description" | "config">[],
): Promise<ToolResult> {
  const names = servers.map((server) => server.name);
  const outcome = await applyOrPropose(
    context,
    `Add the MCP server${names.length === 1 ? "" : "s"} ${names.join(", ")}`,
    servers.map(addServerChange),
    servers.map(addServerReason),
  );
  if (outcome.status === "pending") return outcome.result;
  const library = outcome.values.library ?? EMPTY_LIBRARY;
  const added = library.mcpServers.filter((server) => names.includes(server.name));
  return result(
    `Added ${names.join(", ")}. ${added.length === 1 ? "It stays" : "They stay"} off until mcp_servers_probe with enable: true connects.`,
    { status: "applied", servers: added.map((server) => serverView(server, outcome.values.bots)) },
  );
}

function nameCheck(library: Library, name: string, except?: string): void {
  const others = library.mcpServers.filter((server) => server.id !== except).map((server) => server.name);
  const error = mcpServerNameError(name, others);
  if (error) throw new Error(`${error}.`);
}

/** The app's Test button: connects, lists the tools, and records what it found. */
async function testServer(
  context: ControlContext,
  server: Pick<LibraryMcpServer, "id" | "config">,
  enable: boolean,
): Promise<{ text: string; test: McpTestResult }> {
  const test = await probeMcpServer({ config: server.config }).catch(
    (error: unknown): McpTestResult => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  await saveLibrary(context, (library) => ({
    library: updateMcpServer(library, server.id, testedServer(test, enable)),
  }));
  const text = test.ok
    ? `It connected and lists ${plural(test.tools.length, "tool")}${test.tools.length ? `: ${test.tools.map((tool) => tool.name).join(", ")}` : ""}.${enable ? " It's on." : ""}`
    : `It didn't connect: ${test.error}`;
  return { text, test };
}

const serversList = defineControlTool({
  name: "mcp_servers_list",
  description:
    "List the library's MCP servers, including the built-in Browser one, with the bots that use each. Env and header values show as •••.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_args, context) {
    const { values, library } = await shownLibrary(context);
    const servers = library.mcpServers.map((server) => serverView(server, values.bots));
    return result(servers.map(serverLine).join("\n") || "The library has no MCP servers.", { servers });
  },
});

const serversGet = defineControlTool({
  name: "mcp_servers_get",
  description:
    "Show one MCP server: its connection, last test, tools and bots. Env and header values show as •••.",
  input: z.object({ server: ServerRef }),
  annotations: { readOnlyHint: true },
  async run({ server }, context) {
    const view = await serverById(context, server);
    const tools = view.tools?.map((tool) => tool.name).join(", ");
    const tested = view.checkError
      ? ` Last test failed: ${view.checkError}`
      : tools
        ? ` Tools: ${tools}.`
        : "";
    return result(`${serverLine(view)}${tested}`, { server: view });
  },
});

const serversAdd = defineControlTool({
  name: "mcp_servers_add",
  description:
    "Add an MCP server to the library, like Add server in the app. It waits for the user's approval in the app unless they allow elevated changes, then stays off until mcp_servers_probe with enable: true connects to it.",
  input: z.object({
    name: ServerName,
    description: z.string().max(300).optional(),
    config: ConfigInput,
  }),
  async run({ name, description, config }, context) {
    const { library } = await shownLibrary(context);
    nameCheck(library, name);
    return addServers(context, [
      { name, description: description?.trim() ?? "", config: configFrom(config) },
    ]);
  },
});

const UpdateInput = z.object({
  server: ServerRef,
  name: ServerName.optional(),
  description: z.string().max(300).optional(),
  enabled: z.boolean().optional().describe("Turning it on needs a passed connection test."),
  config: ConfigInput.optional().describe("A new connection; it's tested right away, as the app does."),
});

/** As the app's edit sheet and Enabled switch: a new connection is tested, and only a tested server turns on. */
function serverEdit(current: LibraryMcpServer, library: Library, args: z.infer<typeof UpdateInput>) {
  const name = args.name ?? current.name;
  nameCheck(library, name, current.id);
  const config = args.config ? configFrom(args.config, current.config) : current.config;
  const description = args.description?.trim() ?? current.description;
  const { patch, retest } = editedServer(current, { name, description, config });
  const enableNow = args.enabled === true && !retest;
  if (enableNow && !mcpServerTested(current))
    throw new Error(
      `${current.name} hasn't passed a connection test. mcp_servers_probe with enable: true turns it on once it connects.`,
    );
  if (args.enabled === false || enableNow) patch.enabled = args.enabled;
  return { patch, retest, enableOnTest: args.enabled === true && retest };
}

const serversUpdate = defineControlTool({
  name: "mcp_servers_update",
  description:
    "Change an MCP server's name, description, connection or Enabled switch. Renaming carries the bots' always-allow grants along. A new connection is tested right away, and needs Allow elevated changes without approval; otherwise change it in the app.",
  input: UpdateInput,
  async run(args, context) {
    if (args.config && !(await context.settings()).allowElevated)
      throw new Error(
        `A new connection runs a program or reaches a URL from this computer. Change it in the app, or turn on Allow elevated changes without approval under ${APPROVAL_PLACE}.`,
      );
    const { library } = await shownLibrary(context);
    const current = findServer(library, args.server);
    const edit = serverEdit(current, library, args);
    await saveLibrary(context, (next, bots) =>
      patchedServer({ library: next, bots, id: current.id, patch: edit.patch }),
    );
    const test = edit.retest
      ? await testServer(
          context,
          { id: current.id, config: edit.patch.config ?? current.config },
          edit.enableOnTest,
        )
      : null;
    const view = await serverById(context, current.id);
    return result([`Updated ${view.label}.`, test?.text].filter(Boolean).join(" "), {
      status: "applied",
      server: view,
      ...(test ? { test: test.test } : {}),
    });
  },
});

const serversRemove = defineControlTool({
  name: "mcp_servers_remove",
  description:
    "Delete an MCP server from the library and from every bot, with the tools it let them run without asking.",
  input: z.object({ server: ServerRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ server }, context) {
    const { library } = await shownLibrary(context);
    const entry = findServer(library, server);
    if (entry.id === BROWSER_SERVER_ID)
      throw new Error(
        "The built-in Browser server can't be deleted. Detach it from bots or turn it off instead.",
      );
    await saveLibrary(context, (current, bots) => withoutMcpServer(current, bots, entry.id));
    return result(`Deleted ${entry.name}. No bot gets it any more.`, { removed: entry.id });
  },
});

const serversProbe = defineControlTool({
  name: "mcp_servers_probe",
  description:
    "Test an MCP server like the app's Test button: start or reach it on this host, list its tools and record the result. enable: true turns it on when it connects.",
  input: z.object({
    server: ServerRef,
    enable: z.boolean().optional().describe("Turn it on once it connects, like Test and turn on."),
  }),
  async run({ server, enable }, context) {
    const { library } = await shownLibrary(context);
    const entry = findServer(library, server);
    const { text, test } = await testServer(context, entry, enable === true);
    const view = await serverById(context, entry.id);
    return result(`${view.label}: ${text}`, {
      status: test.ok ? "connected" : "failed",
      ...(test.ok ? { tools: test.tools } : { error: test.error }),
      server: view,
    });
  },
});

async function toggleServer(
  context: ControlContext,
  { server, bot, on }: { server: string; bot: string; on: boolean },
): Promise<ToolResult> {
  const { values, library } = await shownLibrary(context);
  const entry = findServer(library, server);
  const target = findBot(values, bot);
  // The Browser preset only lives in the app's view of the library until something saves it.
  if (!values.library?.mcpServers.some((stored) => stored.id === entry.id))
    await saveLibrary(context, () => ({}));
  const change: Change = {
    type: "update_bot",
    bot: target.id,
    ...(on ? { add_mcp_servers: [entry.id] } : { remove_mcp_servers: [entry.id] }),
  };
  const outcome = await applyOrPropose(context, describeChange(change), [change]);
  if (outcome.status === "pending") return outcome.result;
  const label = mcpServerLabel(entry);
  const off =
    on && !entry.enabled ? ` ${label} is off, so no bot gets it until it's tested and turned on.` : "";
  return result(`${target.name} ${on ? "now uses" : "no longer uses"} ${label}.${off}`, {
    status: "applied",
    bot: target.id,
    server: serverView(entry, outcome.values.bots),
  });
}

const serversAttach = defineControlTool({
  name: "mcp_servers_attach",
  description:
    "Give a bot a library MCP server. A server that's off reaches it once it's tested and on. The Browser server waits for the user's approval.",
  input: z.object({ server: ServerRef, bot: BotRef }),
  async run({ server, bot }, context) {
    return toggleServer(context, { server, bot, on: true });
  },
});

const serversDetach = defineControlTool({
  name: "mcp_servers_detach",
  description: "Take a library MCP server away from a bot.",
  input: z.object({ server: ServerRef, bot: BotRef }),
  async run({ server, bot }, context) {
    return toggleServer(context, { server, bot, on: false });
  },
});

const serversSources = defineControlTool({
  name: "mcp_servers_sources",
  description:
    "List the MCP servers other apps on this computer set up (Claude Code, Claude Desktop, Cursor), for mcp_servers_import.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run() {
    const sources = (await mcpSources()).sources.map((source) => ({
      label: source.label,
      servers: parseMcpJson(source.json).map((server) => server.name),
    }));
    return result(
      sources.map((source) => `${source.label}: ${source.servers.join(", ")}.`).join("\n") ||
        "No other app on this computer has MCP servers set up.",
      { sources },
    );
  },
});

async function importJson(from: string | undefined, json: string | undefined): Promise<string> {
  if (json !== undefined) return json;
  const { sources } = await mcpSources();
  const source = sources.find((entry) => entry.label.toLowerCase() === from?.trim().toLowerCase());
  if (!source)
    throw new Error(
      `No app here called "${from}" has MCP servers.${sources.length ? ` There are: ${sources.map((entry) => entry.label).join(", ")}.` : ""}`,
    );
  return source.json;
}

const serversImport = defineControlTool({
  name: "mcp_servers_import",
  description:
    "Add MCP servers from {\"mcpServers\": {...}} JSON or from another app's setup, like the app's import sheet. They wait for the user's approval in the app unless they allow elevated changes, then arrive off; a taken name gets a number.",
  input: z
    .object({
      json: z
        .string()
        .min(1)
        .max(1_000_000)
        .optional()
        .describe("Claude Code, Cursor or .mcp.json style JSON."),
      from: z.string().min(1).max(100).optional().describe("A label from mcp_servers_sources."),
    })
    .refine(
      (input) => (input.json === undefined) !== (input.from === undefined),
      "Give either json or from.",
    ),
  async run({ json, from }, context) {
    const drafts = parseMcpJson(await importJson(from, json));
    const { library } = await shownLibrary(context);
    const known = new Set(library.mcpServers.map((server) => server.id));
    const added = addMcpServers(library, drafts).library.mcpServers.filter((server) => !known.has(server.id));
    if (!added.length)
      return result("Those servers are in the library already.", { status: "applied", servers: [] });
    return addServers(context, added);
  },
});

// Skills

interface SkillView extends Pick<LibrarySkill, "id" | "description" | "source" | "enabled"> {
  needsReview: boolean;
  changedSinceReview: boolean;
  /** Bots get it only while it's on and reviewed. */
  active: boolean;
  bots: NamedBot[];
}

function skillView(skill: LibrarySkill, sha: string | null, bots: readonly Bot[]): SkillView {
  const needsReview = skillNeedsReview(skill, sha);
  return {
    id: skill.id,
    description: skill.description,
    source: skill.source,
    enabled: skill.enabled,
    needsReview,
    changedSinceReview: typeof skill.reviewedSha === "string" && needsReview,
    active: skill.enabled && !needsReview,
    bots: bots.filter((bot) => bot.skillIds.includes(skill.id)).map(({ id, name }) => ({ id, name })),
  };
}

function skillLine(view: SkillView): string {
  const state = view.needsReview
    ? view.changedSinceReview
      ? "changed since its review"
      : "needs a review"
    : view.enabled
      ? "on"
      : "off";
  const bots = view.bots.map((bot) => bot.name).join(", ") || "no bots";
  return `${view.id}: ${state}; ${view.description || "no description"}; used by ${bots}.`;
}

async function skillById(context: ControlContext, id: string): Promise<SkillView> {
  const values = await context.host.values();
  return skillView(findSkill(values.library ?? EMPTY_LIBRARY, id), await skillSha(id), values.bots);
}

const SkillId = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (id) => sanitizeSkillName(id) === id,
    "Use lowercase letters, digits, dots, dashes and underscores.",
  )
  .describe("The skill's id: its folder and the name bots see, as in weekly-report.");

const skillsList = defineControlTool({
  name: "skills_list",
  description:
    "List the library's skills: whether each is on or waits for a review, and the bots that use it.",
  input: z.object({}),
  annotations: { readOnlyHint: true },
  async run(_args, context) {
    const values = await context.host.values();
    const skills = await Promise.all(
      (values.library ?? EMPTY_LIBRARY).skills.map(async (skill) =>
        skillView(skill, await skillSha(skill.id), values.bots),
      ),
    );
    return result(skills.map(skillLine).join("\n") || "The library has no skills.", { skills });
  },
});

const skillsRead = defineControlTool({
  name: "skills_read",
  description:
    "Read a skill's SKILL.md, its sha for skills_review, the other files that come with it, and what the review flags.",
  input: z.object({ skill: SkillRef }),
  annotations: { readOnlyHint: true },
  async run({ skill }, context) {
    const { id } = findSkill(await context.host.library(), skill);
    const file = await readSkill({ id });
    const warnings = scanSkillText(file.text);
    return result(file.missing ? `${id} has no SKILL.md.` : file.text, {
      skill: await skillById(context, id),
      text: file.text,
      sha: file.sha,
      missing: file.missing,
      files: file.files,
      warnings,
    });
  },
});

const skillsImport = defineControlTool({
  name: "skills_import",
  description:
    "Import skills from GitHub or a SKILL.md link, or update one from where it came from. They arrive off and need a review; an update needs a new one.",
  input: z
    .object({
      source: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('"owner/repo", a GitHub folder or a SKILL.md link. A repository brings up to 30 skills.'),
      skill: SkillRef.optional().describe("An imported skill to update from its source."),
    })
    .refine(
      (input) => (input.source === undefined) !== (input.skill === undefined),
      "Give either source or skill.",
    ),
  async run({ source, skill }, context) {
    let from = source?.trim() ?? "";
    if (skill !== undefined) {
      const entry = findSkill(await context.host.library(), skill);
      from = skillUpdateSource(entry.source) ?? "";
      if (!from) throw new Error(`${entry.id} was written here, so it has no source to update from.`);
    }
    const { skills } = await importSkills({ source: from });
    await saveLibrary(context, (library) => ({ library: upsertSkills(library, skills) }));
    const views = await Promise.all(skills.map((entry) => skillById(context, entry.id)));
    return result(`${addedSkillsMessage(skills)} skills_read shows each, skills_review turns it on.`, {
      skills: views,
    });
  },
});

const skillsWrite = defineControlTool({
  name: "skills_write",
  description:
    "Write a skill's SKILL.md, creating the skill if it's new. What's written here counts as reviewed, as in the app's editor; a new skill arrives on.",
  input: z.object({
    id: SkillId,
    text: z
      .string()
      .min(1)
      .max(512 * 1024)
      .describe("The whole SKILL.md: frontmatter with name and description, then the instructions."),
  }),
  async run({ id, text }, context) {
    const saved = await writeSkill({ id, text });
    await saveLibrary(context, (library) => ({
      library: upsertSkills(library, [
        { id, description: saved.description, source: "", reviewedSha: saved.sha },
      ]),
    }));
    const warning = skillTextWarning(text, id);
    return result(`Saved ${id}.${warning ? ` ${warning}.` : ""}`, {
      skill: await skillById(context, id),
      sha: saved.sha,
      ...(warning ? { warning } : {}),
    });
  },
});

const skillsReview = defineControlTool({
  name: "skills_review",
  description:
    "Approve a skill after reading it, like Turn on in the app's review: it records the sha of exactly that SKILL.md and turns the skill on.",
  input: z.object({
    skill: SkillRef,
    sha: z.string().min(1).max(100).describe("The sha skills_read returned for the text you read."),
  }),
  async run({ skill, sha }, context) {
    const { id } = findSkill(await context.host.library(), skill);
    const current = await skillSha(id);
    if (current === null) throw new Error(`${id} has no SKILL.md to review.`);
    if (current !== sha) throw new Error(`${id}'s SKILL.md changed since that read. Read it again first.`);
    await saveLibrary(context, (library) => ({
      library: updateSkill(library, id, { enabled: true, reviewedSha: sha }),
    }));
    return result(`Reviewed ${id}; it's on.`, { skill: await skillById(context, id) });
  },
});

const skillsSetEnabled = defineControlTool({
  name: "skills_set_enabled",
  description:
    "Turn a skill on or off for every bot. Turning on a skill that needs a review takes skills_review.",
  input: z.object({ skill: SkillRef, enabled: z.boolean() }),
  async run({ skill, enabled }, context) {
    const entry = findSkill(await context.host.library(), skill);
    if (enabled && skillNeedsReview(entry, await skillSha(entry.id)))
      throw new Error(`${entry.id} needs a review first: skills_read it, then skills_review.`);
    await saveLibrary(context, (library) => ({ library: updateSkill(library, entry.id, { enabled }) }));
    return result(`${entry.id} is ${enabled ? "on" : "off"}.`, { skill: await skillById(context, entry.id) });
  },
});

const skillsDelete = defineControlTool({
  name: "skills_delete",
  description: "Delete a skill: its files, its library entry, and every bot's use of it.",
  input: z.object({ skill: SkillRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ skill }, context) {
    const { id } = findSkill(await context.host.library(), skill);
    await deleteSkill({ id });
    await saveLibrary(context, (library, bots) => withoutSkill(library, bots, id));
    return result(`Deleted ${id}. No bot gets it any more.`, { removed: id });
  },
});

async function toggleSkill(
  context: ControlContext,
  { skill, bot, on }: { skill: string; bot: string; on: boolean },
): Promise<ToolResult> {
  const values = await context.host.values();
  const entry = findSkill(values.library ?? EMPTY_LIBRARY, skill);
  const target = findBot(values, bot);
  const change: Change = {
    type: "update_bot",
    bot: target.id,
    ...(on ? { add_skills: [entry.id] } : { remove_skills: [entry.id] }),
  };
  const outcome = await applyOrPropose(context, describeChange(change), [change]);
  if (outcome.status === "pending") return outcome.result;
  const view = skillView(entry, await skillSha(entry.id), outcome.values.bots);
  const inactive = on && !view.active ? ` ${entry.id} reaches it once it's reviewed and on.` : "";
  return result(`${target.name} ${on ? "now uses" : "no longer uses"} ${entry.id}.${inactive}`, {
    status: "applied",
    bot: target.id,
    skill: view,
  });
}

const skillsAttach = defineControlTool({
  name: "skills_attach",
  description: "Give a bot a library skill. One that's off or waits for a review reaches it once it's on.",
  input: z.object({ skill: SkillRef, bot: BotRef }),
  async run({ skill, bot }, context) {
    return toggleSkill(context, { skill, bot, on: true });
  },
});

const skillsDetach = defineControlTool({
  name: "skills_detach",
  description: "Take a library skill away from a bot.",
  input: z.object({ skill: SkillRef, bot: BotRef }),
  async run({ skill, bot }, context) {
    return toggleSkill(context, { skill, bot, on: false });
  },
});

export const LIBRARY_TOOLS: readonly ControlTool[] = [
  serversList,
  serversGet,
  serversAdd,
  serversUpdate,
  serversRemove,
  serversProbe,
  serversAttach,
  serversDetach,
  serversSources,
  serversImport,
  skillsList,
  skillsRead,
  skillsImport,
  skillsWrite,
  skillsReview,
  skillsSetEnabled,
  skillsDelete,
  skillsAttach,
  skillsDetach,
];
