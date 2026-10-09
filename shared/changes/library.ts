import { type BotState, EMPTY_LIBRARY, type McpServerConfig } from "../bot";
import { addMcpServers, mcpServerTested, withoutMcpServer } from "../library";
import { RESERVED_MCP_NAMES } from "../mcp-servers";
import type { ApplyContext } from "./context";
import { findServer, findSkill } from "./refs";
import type { ChangeOf } from "./schema";

export function setSkill(values: BotState, change: ChangeOf<"set_skill">, context: ApplyContext): BotState {
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

export function addMcpServer(
  values: BotState,
  change: ChangeOf<"add_mcp_server">,
  context: ApplyContext,
): BotState {
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

export function setMcpServer(
  values: BotState,
  change: ChangeOf<"set_mcp_server">,
  context: ApplyContext,
): BotState {
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

export function removeMcpServer(values: BotState, change: ChangeOf<"remove_mcp_server">): BotState {
  const library = values.library ?? EMPTY_LIBRARY;
  const server = findServer(library, change.server);
  return { ...values, ...withoutMcpServer(library, values.bots, server.id) };
}
