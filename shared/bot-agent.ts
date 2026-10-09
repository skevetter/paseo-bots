import { APPS_MCP_NAME } from "./apps";
import type { Bot, Library, LibraryMcpServer, LibrarySkill, McpServerConfig } from "./bot";
import { QUIET_TOOLS, supportsToolGrants, TOOLS_MCP_NAME } from "./bot-tools";
import { RESERVED_MCP_NAMES } from "./mcp-servers";

export function botMcpServers(bot: Pick<Bot, "mcpServerIds">, library: Library): LibraryMcpServer[] {
  return bot.mcpServerIds.flatMap((id) => {
    const server = library.mcpServers.find((entry) => entry.id === id);
    return server?.enabled && server.name.trim() ? [server] : [];
  });
}

export function botSkills(bot: Pick<Bot, "skillIds">, library: Library): LibrarySkill[] {
  return bot.skillIds.flatMap((id) => {
    const skill = library.skills.find((entry) => entry.id === id);
    return skill?.enabled ? [skill] : [];
  });
}

function mcpServersRecord(
  servers: readonly Pick<LibraryMcpServer, "name" | "config">[],
): Record<string, McpServerConfig> {
  const record: Record<string, McpServerConfig> = {};
  for (const server of servers) {
    const name = server.name.trim();
    // Paseo adds its own "paseo" server and connected apps use "composio"; ours can't replace them.
    if (name && !RESERVED_MCP_NAMES.includes(name)) record[name] = server.config;
  }
  return record;
}

export interface PluginServers {
  apps?: McpServerConfig | null;
  tools?: McpServerConfig | null;
}

/** The SDK needs an explicit model, so bots on "provider default" pass the resolved default in. */
export function buildAgentConfig(
  bot: Bot,
  agent: { library: Library; model: string; systemPrompt: string; plugin?: PluginServers },
) {
  const { library, model, systemPrompt, plugin = {} } = agent;
  const mcpServers: Record<string, McpServerConfig> = {
    ...mcpServersRecord(botMcpServers(bot, library)),
    ...(plugin.apps ? { [APPS_MCP_NAME]: plugin.apps } : {}),
    ...(plugin.tools ? { [TOOLS_MCP_NAME]: plugin.tools } : {}),
  };
  // Quiet tools run without prompts; ask_bot too once the user allowed it for this bot.
  const quiet = plugin.tools
    ? [...QUIET_TOOLS, ...(bot.contactBots === "allow" ? ["ask_bot"] : [])].map(
        (tool) => `${TOOLS_MCP_NAME}/${tool}`,
      )
    : [];
  // Paseo rejects the whole request when a grant names a server it doesn't carry
  // (a server switched off for the bot, or Paseo's own, which is added later),
  // and when the provider can't take exact grants at all.
  const preapproved = supportsToolGrants(bot.provider)
    ? toolGrants([...quiet, ...bot.alwaysAllow]).filter((grant) => grant.server in mcpServers)
    : [];
  return {
    provider: `${bot.provider}/${model}`,
    ...(bot.modeId ? { modeId: bot.modeId } : {}),
    ...(bot.thinkingOptionId ? { thinkingOptionId: bot.thinkingOptionId } : {}),
    systemPrompt,
    ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
    ...(preapproved.length > 0 ? { toolPolicy: { preapproved } } : {}),
  };
}

export function toolGrants(entries: readonly string[]): { kind: "mcp"; server: string; tool: string }[] {
  return entries.flatMap((entry) => {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(entry.trim());
    const [, server, tool] = match ?? [];
    return server && tool ? [{ kind: "mcp" as const, server, tool }] : [];
  });
}

export function defaultModelId(
  models: readonly { id: string; isDefault?: boolean; isSelectable?: boolean }[],
): string | null {
  const selectable = models.filter((model) => model.isSelectable !== false);
  return (selectable.find((model) => model.isDefault) ?? selectable[0])?.id ?? null;
}
