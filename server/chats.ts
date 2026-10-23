import { createHash } from "node:crypto";
import type { z } from "zod";
import { APPS_MCP_NAME } from "../shared/apps";
import { type Bot, type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { TOOLS_MCP_NAME } from "../shared/bot-tools";
import {
  launchPreparedBotChat,
  type PreparedBotChat,
  type PreparedLaunchOptions,
  prepareBotChat,
  type StartChatInput,
} from "../shared/chat";
import type { LocalChatInputSchema, LocalChatStartResult } from "../shared/local-start";
import { newUuid } from "../shared/uuid";
import { ensureBotHome } from "./bot-home";
import type { BotsHost } from "./host";
import { systemPrompt } from "./prompt";
import type { Relay } from "./relay";

export interface PrepareChatInput
  extends Omit<
    StartChatInput,
    "bot" | "library" | "policy" | "placement" | "systemPrompt" | "plugin" | "context" | "onEvent"
  > {
  agentId: string;
  idempotencyKey: string;
  state?: BotState;
  inputArtifactRefs?: string[];
  environmentVersion?: string;
}

/** Admission resolves prompts, memory and permissions exactly once. The result is restricted data. */
export async function prepareChat(
  host: BotsHost,
  relay: Relay,
  bot: Bot,
  input: PrepareChatInput,
): Promise<PreparedBotChat> {
  const paseo = host.requirePaseo();
  if (bot.hostId)
    throw new Error(`${bot.name} runs on another host, so its chats can't be started from here.`);
  const values = input.state ?? (await host.values());
  const library = values.library ?? EMPTY_LIBRARY;
  const home = await ensureBotHome({ botId: bot.id });
  const composed = await systemPrompt({ bot, local: true, message: input.prompt }, library, paseo, values);
  const frozenRelay = {
    tools: true,
    apps: bot.apps.length > 0 && (await relay.mountApps(bot.id)) !== null,
    permissions: await relay.preparePermissions(bot),
  };
  const prepared = await prepareBotChat(paseo, {
    ...input,
    bot,
    library,
    policy: values,
    plugin: await relay.mountPrepared(bot.id, input.agentId, frozenRelay),
    placement: bot.cwd ? { path: bot.cwd, projectRoot: null } : { path: home.path, projectRoot: home.root },
    systemPrompt: composed.systemPrompt,
    context: {
      systemPromptHash: createHash("sha256").update(composed.systemPrompt).digest("hex"),
      userPromptHash: createHash("sha256").update(input.prompt).digest("hex"),
      memoryContextReceipt: composed.memoryContextReceipt,
      playbooks: composed.playbooks,
      inputArtifactRefs: input.inputArtifactRefs ?? [],
      environmentVersion: input.environmentVersion ?? null,
    },
  });
  prepared.relay = frozenRelay;
  return prepared;
}

/** Also used when cold recovery adopts an already-created agent without launching it again. */
export async function refreshPreparedChat(relay: Relay, prepared: PreparedBotChat): Promise<PreparedBotChat> {
  if (!prepared.relay) return prepared;
  const plugin = await relay.mountPrepared(prepared.botId, prepared.agentId, prepared.relay);
  const mcpServers = { ...prepared.config.mcpServers };
  for (const [name, refreshed] of [
    [TOOLS_MCP_NAME, plugin.tools],
    [APPS_MCP_NAME, plugin.apps],
  ] as const) {
    if (!refreshed) continue;
    const frozen = mcpServers[name];
    if (frozen?.type !== "http" || refreshed.type !== "http") {
      throw new Error("Prepared relay configuration does not match its admitted permission envelope.");
    }
    mcpServers[name] = {
      ...frozen,
      url: refreshed.url,
      headers: { ...frozen.headers, Authorization: refreshed.headers.Authorization },
    };
  }
  return { ...prepared, config: { ...prepared.config, mcpServers } };
}

export async function launchPreparedChat(
  host: BotsHost,
  relay: Relay,
  prepared: PreparedBotChat,
  options?: PreparedLaunchOptions,
): Promise<string> {
  if (prepared.hostId) throw new Error("A remote prepared chat must launch on its selected host.");
  return launchPreparedBotChat(host.requirePaseo(), await refreshPreparedChat(relay, prepared), options);
}

/** Ordinary local starts share the explicitly bound admission service. */
export function startChat(
  host: BotsHost,
  input: Omit<z.input<typeof LocalChatInputSchema>, "requestId"> & { requestId?: string },
): Promise<LocalChatStartResult> {
  return host.requireChatStarts().create({ ...input, requestId: input.requestId ?? newUuid() });
}
