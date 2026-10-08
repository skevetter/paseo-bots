import { z } from "zod";

// Paseo's ACP providers name a tool call by its ACP kind ("other" for MCP
// tools) and keep the agent's title, `"<tool>: <preview>"` or the bare tool,
// in `metadata.title`; permission requests carry that title in `title`.

const AcpToolMetadata = z.object({ kind: z.string().optional(), title: z.string() });
const AcpPermissionMetadata = z.object({
  rawRequest: z.object({ toolCall: z.object({ rawInput: z.record(z.string(), z.unknown()).optional() }) }),
});

function titleToolName(title: string): string | null {
  const [head = ""] = title.split(": ", 1);
  const trimmed = head.trim();
  return /^[\w.-]+$/.test(trimmed) ? trimmed : null;
}

export function toolCallName(call: { name: string; metadata?: unknown }): string {
  const metadata = AcpToolMetadata.safeParse(call.metadata);
  if (!metadata.success || (call.name !== metadata.data.kind && call.name !== metadata.data.title))
    return call.name;
  return titleToolName(metadata.data.title) ?? call.name;
}

export function permissionToolName(request: { name: string; title?: string; metadata?: unknown }): string {
  if (!request.title || !AcpPermissionMetadata.safeParse(request.metadata).success) return request.name;
  return titleToolName(request.title) ?? request.name;
}

/** ACP providers keep the arguments only in the raw request. */
export function permissionInput(request: {
  input?: Record<string, unknown>;
  metadata?: unknown;
}): Record<string, unknown> | null {
  if (request.input) return request.input;
  const metadata = AcpPermissionMetadata.safeParse(request.metadata);
  return metadata.success ? (metadata.data.rawRequest.toolCall.rawInput ?? null) : null;
}

/**
 * Provider spellings: Claude and Hermes `mcp__bots__ask_bot`, Codex
 * `bots.ask_bot`, omp `bots / ask_bot`, others `bots_ask_bot`.
 */
export function serverToolName(name: string, server: string): string | null {
  const match = /^(?:mcp__)?([A-Za-z0-9-]+?)(?:__|\.|_| \/ )(\w+)$/.exec(name.trim());
  const [, matchedServer, tool] = match ?? [];
  return matchedServer === server && tool ? tool : null;
}
