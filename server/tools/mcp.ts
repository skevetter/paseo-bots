import { type ZodType, z } from "zod";
import type { Bot } from "../../shared/bot";
import type { BotToolName } from "../../shared/bot-tools";
import { PLUGIN_VERSION } from "../../shared/version";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";

// A minimal MCP server over streamable HTTP: stateless JSON-RPC with JSON
// answers, enough for initialize, tools/list and tools/call. Each request
// comes from one bot's chat, identified by the relay from its URL and token.

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolCaller {
  bot: Bot;
  /** The chat (agent) the call came from. */
  agentId: string;
  host: BotsHost;
  /** Starts other bots' chats with their tools. */
  relay: Relay;
}

export interface BotTool<Schema extends ZodType = ZodType> {
  name: BotToolName;
  description: string;
  input: Schema;
  /** Whether this bot gets the tool at all (for example, only with other bots to ask). */
  available?(caller: ToolCaller): boolean | Promise<boolean>;
  run(args: z.output<Schema>, caller: ToolCaller): Promise<string>;
}

export function defineTool<Schema extends ZodType>(tool: BotTool<Schema>): BotTool {
  return tool as unknown as BotTool;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
};

function inputSchema(schema: ZodType): Record<string, unknown> {
  const { $schema: _schema, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

function issues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
}

type Answer = { result: unknown } | { error: { code: number; message: string } };

async function offeredTools(tools: readonly BotTool[], caller: ToolCaller): Promise<BotTool[]> {
  const list: BotTool[] = [];
  for (const tool of tools) if (!tool.available || (await tool.available(caller))) list.push(tool);
  return list;
}

async function callTool(
  params: JsonRpcRequest["params"],
  tools: readonly BotTool[],
  caller: ToolCaller,
): Promise<Answer> {
  const tool = (await offeredTools(tools, caller)).find((entry) => entry.name === params?.name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool ${String(params?.name)}` } };
  const parsed = tool.input.safeParse(params?.arguments ?? {});
  if (!parsed.success)
    return {
      result: {
        content: [{ type: "text", text: `Invalid arguments. ${issues(parsed.error)}` }],
        isError: true,
      },
    };
  try {
    return { result: { content: [{ type: "text", text: await tool.run(parsed.data, caller) }] } };
  } catch (error) {
    return {
      result: {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      },
    };
  }
}

async function answer(
  message: JsonRpcRequest,
  tools: readonly BotTool[],
  caller: ToolCaller,
): Promise<Answer> {
  switch (message.method) {
    case "initialize": {
      const requested =
        typeof message.params?.protocolVersion === "string"
          ? message.params.protocolVersion
          : PROTOCOL_VERSION;
      return {
        result: {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "paseo-bots", version: PLUGIN_VERSION },
        },
      };
    }
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: (await offeredTools(tools, caller)).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchema(tool.input),
          })),
        },
      };
    case "tools/call":
      return callTool(message.params, tools, caller);
    default:
      return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

/** Answers one JSON-RPC message; null for notifications, which get no answer. */
export async function answerMcp(
  message: JsonRpcRequest,
  tools: readonly BotTool[],
  caller: ToolCaller,
): Promise<JsonRpcResponse | null> {
  if (message.id === undefined || message.id === null) {
    // Notifications (notifications/initialized, cancellations) need no reply.
    if (message.method?.startsWith("notifications/")) return null;
  }
  return { jsonrpc: "2.0", id: message.id ?? null, ...(await answer(message, tools, caller)) };
}
