import type { Library, LibraryMcpServer, McpServerConfig } from "./bot";
import { uniqueName } from "./bot-ids";
import { RESERVED_MCP_NAMES } from "./mcp-servers";

export const BROWSER_SERVER_ID = "mcp-browser";
export const BROWSER_LABEL = "Browser (your Chromium browser)";
export const DEFAULT_BROWSER_URL = "http://127.0.0.1:9222";
const BROWSER_NAME = "browser";
const PACKAGE = "chrome-devtools-mcp";
const PACKAGE_VERSION = "1.10.1";
const URL_FLAG = "--browserUrl";

export const BROWSER_DESCRIPTION =
  "Drives the Chrome, Brave, Edge or other Chromium browser you already use, so a bot acts as you on every site you're signed in to. Start the browser with --remote-debugging-port=9222 (the port in its address) before testing.";

function browserConfig(): McpServerConfig {
  return {
    type: "stdio",
    command: "npx",
    args: ["-y", `${PACKAGE}@${PACKAGE_VERSION}`, URL_FLAG, DEFAULT_BROWSER_URL, "--no-usage-statistics"],
    env: {},
  };
}

function runsDevtoolsMcp(config: McpServerConfig): config is Extract<McpServerConfig, { type: "stdio" }> {
  return (
    config.type === "stdio" && config.args.some((arg) => arg === PACKAGE || arg.startsWith(`${PACKAGE}@`))
  );
}

export function isBrowserServer(server: Pick<LibraryMcpServer, "id" | "config">): boolean {
  return server.id === BROWSER_SERVER_ID || runsDevtoolsMcp(server.config);
}

export function mcpServerLabel(server: Pick<LibraryMcpServer, "id" | "name" | "config">): string {
  return isBrowserServer(server) ? BROWSER_LABEL : server.name;
}

/** The address chrome-devtools-mcp attaches to; null when it launches its own browser. */
export function browserUrlOf(config: McpServerConfig): string | null {
  if (!runsDevtoolsMcp(config)) return null;
  const flag = config.args.indexOf(URL_FLAG);
  if (flag >= 0) return config.args[flag + 1] ?? null;
  const inline = config.args.find((arg) => arg.startsWith(`${URL_FLAG}=`));
  return inline ? inline.slice(URL_FLAG.length + 1) : null;
}

export function withBrowserUrl(config: McpServerConfig, url: string): McpServerConfig {
  if (config.type !== "stdio") return config;
  const args = config.args.filter((arg) => !arg.startsWith(`${URL_FLAG}=`));
  const flag = args.indexOf(URL_FLAG);
  if (flag >= 0) args.splice(flag, 2, URL_FLAG, url);
  else args.push(URL_FLAG, url);
  return { ...config, args };
}

export function browserUnreachableMessage(url: string): string {
  const port = /^[a-z]+:\/\/[^/:]+:(\d+)/i.exec(url)?.[1] ?? "9222";
  return `Can't reach your browser at ${url}. Start Chrome, Brave or another Chromium browser with --remote-debugging-port=${port}, then test again.`;
}

function browserPreset(library: Library, now: string): LibraryMcpServer {
  const taken = new Set([...RESERVED_MCP_NAMES, ...library.mcpServers.map((server) => server.name)]);
  return {
    id: BROWSER_SERVER_ID,
    name: uniqueName(BROWSER_NAME, taken),
    description: BROWSER_DESCRIPTION,
    enabled: false,
    config: browserConfig(),
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The library always has a browser entry: an existing one that runs chrome-devtools-mcp, or the preset. */
export function withBrowserServer(library: Library, now: string = new Date().toISOString()): Library {
  if (library.mcpServers.some(isBrowserServer)) return library;
  return { ...library, mcpServers: [...library.mcpServers, browserPreset(library, now)] };
}
