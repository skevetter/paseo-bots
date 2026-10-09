import { type ZodType, z } from "zod";
import type { Bot } from "../../shared/bot";
import type { BotToolName } from "../../shared/bot-tools";
import { PLUGIN_VERSION } from "../../shared/version";
import type { BotsHost } from "../host";
import type { Relay } from "../relay";

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolCaller {
  bot: Bot;
  agentId: string;
  host: BotsHost;
  relay: Relay;
}

/** `data` becomes the result's structuredContent. */
export interface ToolResult {
  text: string;
  data?: Record<string, unknown>;
}

export interface McpTool<Caller, Schema extends ZodType = ZodType> {
  name: string;
  description: string;
  input: Schema;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  available?(caller: Caller): boolean | Promise<boolean>;
  run(args: z.output<Schema>, caller: Caller): Promise<string | ToolResult>;
}

export interface BotTool<Schema extends ZodType = ZodType> extends McpTool<ToolCaller, Schema> {
  name: BotToolName;
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

async function offeredTools<Caller>(
  tools: readonly McpTool<Caller>[],
  caller: Caller,
): Promise<McpTool<Caller>[]> {
  const list: McpTool<Caller>[] = [];
  for (const tool of tools) if (!tool.available || (await tool.available(caller))) list.push(tool);
  return list;
}

function failure(text: string) {
  return { result: { content: [{ type: "text", text }], isError: true } };
}

function success(output: string | ToolResult) {
  const { text, data } = typeof output === "string" ? { text: output, data: undefined } : output;
  return { result: { content: [{ type: "text", text }], ...(data ? { structuredContent: data } : {}) } };
}

async function callTool<Caller>(
  params: JsonRpcRequest["params"],
  tools: readonly McpTool<Caller>[],
  caller: Caller,
): Promise<Answer> {
  const tool = (await offeredTools(tools, caller)).find((entry) => entry.name === params?.name);
  if (!tool) return { error: { code: -32602, message: `Unknown tool ${String(params?.name)}` } };
  const parsed = tool.input.safeParse(params?.arguments ?? {});
  if (!parsed.success) return failure(`Invalid arguments. ${issues(parsed.error)}`);
  try {
    return success(await tool.run(parsed.data, caller));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function initialize(message: JsonRpcRequest, name: string): Answer {
  const requested = message.params?.protocolVersion;
  return {
    result: {
      protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name, version: PLUGIN_VERSION },
    },
  };
}

async function answer<Caller>(
  message: JsonRpcRequest,
  server: McpServerSpec<Caller>,
  caller: Caller,
): Promise<Answer> {
  switch (message.method) {
    case "initialize":
      return initialize(message, server.name);
    case "ping":
      return { result: {} };
    case "tools/list":
      return {
        result: {
          tools: (await offeredTools(server.tools, caller)).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: inputSchema(tool.input),
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        },
      };
    case "tools/call":
      return callTool(message.params, server.tools, caller);
    default:
      return { error: { code: -32601, message: `Method not found: ${String(message.method)}` } };
  }
}

export interface McpServerSpec<Caller> {
  name: string;
  tools: readonly McpTool<Caller>[];
}

/** null for notifications, which get no answer. */
export async function answerMcp<Caller>(
  message: JsonRpcRequest,
  server: McpServerSpec<Caller>,
  caller: Caller,
): Promise<JsonRpcResponse | null> {
  if (message.id === undefined || message.id === null) {
    if (message.method?.startsWith("notifications/")) return null;
  }
  return { jsonrpc: "2.0", id: message.id ?? null, ...(await answer(message, server, caller)) };
}
