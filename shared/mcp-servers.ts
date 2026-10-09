import { APPS_MCP_NAME } from "./apps";
import type { BotMcpServer } from "./bot";
import { TOOLS_MCP_NAME } from "./bot-tools";
import { PASEO_MCP_NAME } from "./paseo-tools";

/** Taken by MCP servers bots get from elsewhere. */
export const RESERVED_MCP_NAMES: readonly string[] = [PASEO_MCP_NAME, APPS_MCP_NAME, TOOLS_MCP_NAME];

/** MCP server keys agents accept (the key prefixes every tool name). */
export const MCP_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function mcpServerFromEntry(name: string, raw: unknown): BotMcpServer | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const type = typeof entry.type === "string" ? entry.type : undefined;
  if (typeof entry.command === "string" && (type === undefined || type === "stdio")) {
    const args = Array.isArray(entry.args)
      ? entry.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return {
      name,
      enabled: true,
      config: { type: "stdio", command: entry.command, args, env: stringRecord(entry.env) },
    };
  }
  if (typeof entry.url !== "string") return null;
  return {
    name,
    enabled: true,
    config: { type: type === "sse" ? "sse" : "http", url: entry.url, headers: stringRecord(entry.headers) },
  };
}

/** Accepts `{ "mcpServers": { name: config } }` (Claude Code, Cursor, `.mcp.json`) or a bare `{ name: config }` map. */
export function parseMcpJson(text: string): BotMcpServer[] {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Expected a JSON object of MCP servers.");
  }
  const root = parsed as Record<string, unknown>;
  const map =
    root.mcpServers && typeof root.mcpServers === "object"
      ? (root.mcpServers as Record<string, unknown>)
      : root;
  const servers: BotMcpServer[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const server = mcpServerFromEntry(name, raw);
    if (server) servers.push(server);
  }
  if (servers.length === 0) throw new Error("No MCP servers found in that JSON.");
  return servers;
}

export function formatPairs(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function parsePairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

interface ArgScan {
  args: string[];
  current: string;
  quote: '"' | "'" | null;
  started: boolean;
}

function scanUnquoted(scan: ArgScan, char: string): void {
  if (char === '"' || char === "'") {
    scan.quote = char;
    scan.started = true;
  } else if (/\s/.test(char)) {
    if (scan.started) scan.args.push(scan.current);
    scan.current = "";
    scan.started = false;
  } else {
    scan.current += char;
    scan.started = true;
  }
}

export function splitArgs(text: string): string[] {
  const scan: ArgScan = { args: [], current: "", quote: null, started: false };
  for (const char of text) {
    if (scan.quote === null) scanUnquoted(scan, char);
    else if (char === scan.quote) scan.quote = null;
    else scan.current += char;
  }
  if (scan.started) scan.args.push(scan.current);
  return scan.args;
}

export function joinArgs(args: readonly string[]): string {
  return args
    .map((arg) => (arg === "" || /[\s"']/.test(arg) ? `"${arg.replace(/"/g, "'")}"` : arg))
    .join(" ");
}
