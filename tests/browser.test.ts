import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { probeMcpServer } from "../server/mcp-probe";
import type { Library, LibraryMcpServer, McpServerConfig } from "../shared/bot";
import {
  BROWSER_LABEL,
  BROWSER_SERVER_ID,
  browserUrlOf,
  isBrowserServer,
  mcpServerLabel,
  withBrowserServer,
  withBrowserUrl,
} from "../shared/browser";
import { NOW } from "./helpers";

function libraryServer(patch: Partial<LibraryMcpServer> & Pick<LibraryMcpServer, "id" | "name" | "config">) {
  return {
    description: "",
    enabled: true,
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  } satisfies LibraryMcpServer;
}

const liveBraveEntry = libraryServer({
  id: "mcp-brave-browser",
  name: "brave-browser",
  enabled: true,
  config: {
    type: "stdio",
    command: "npx",
    args: [
      "-y",
      "chrome-devtools-mcp@1.10.1",
      "--browserUrl",
      "http://127.0.0.1:9222",
      "--no-usage-statistics",
    ],
    env: {},
  },
});

describe("browser preset", () => {
  it("is added to a library without one, switched off and pinned to a chrome-devtools-mcp version", () => {
    const library = withBrowserServer({ skills: [], mcpServers: [] }, NOW);
    expect(library.mcpServers).toHaveLength(1);
    const [preset] = library.mcpServers;
    expect(preset).toMatchObject({ id: BROWSER_SERVER_ID, name: "browser", enabled: false, tools: null });
    expect(preset?.config).toEqual({
      type: "stdio",
      command: "npx",
      args: [
        "-y",
        "chrome-devtools-mcp@1.10.1",
        "--browserUrl",
        "http://127.0.0.1:9222",
        "--no-usage-statistics",
      ],
      env: {},
    });
    expect(preset?.description).toMatch(/signed in/);
    expect(preset?.description).toContain("--remote-debugging-port");
    expect(preset && mcpServerLabel(preset)).toBe(BROWSER_LABEL);
  });

  it("adopts an existing chrome-devtools-mcp entry instead of adding a second one", () => {
    const other = libraryServer({
      id: "mcp-gmail",
      name: "gmail",
      config: { type: "http", url: "https://x.test/mcp", headers: {} },
    });
    const library: Library = { skills: [], mcpServers: [other, liveBraveEntry] };
    const adopted = withBrowserServer(library, NOW);
    expect(adopted).toBe(library);
    expect(isBrowserServer(liveBraveEntry)).toBe(true);
    expect(mcpServerLabel(liveBraveEntry)).toBe(BROWSER_LABEL);
    expect(mcpServerLabel(other)).toBe("gmail");
  });

  it("adopts the preset's own id after its command was changed", () => {
    const edited = libraryServer({
      id: BROWSER_SERVER_ID,
      name: "browser",
      config: { type: "stdio", command: "/usr/local/bin/devtools", args: [], env: {} },
    });
    const library: Library = { skills: [], mcpServers: [edited] };
    expect(withBrowserServer(library, NOW)).toBe(library);
  });

  it("takes a free name when a different server is already called browser", () => {
    const taken = libraryServer({
      id: "mcp-x",
      name: "browser",
      config: { type: "stdio", command: "browser-tool", args: [], env: {} },
    });
    const library = withBrowserServer({ skills: [], mcpServers: [taken] }, NOW);
    expect(library.mcpServers.map((server) => server.name)).toEqual(["browser", "browser-2"]);
  });

  it("edits the browser address in place and keeps the other arguments", () => {
    const moved = withBrowserUrl(liveBraveEntry.config, "http://127.0.0.1:9333");
    expect(moved.type === "stdio" && moved.args).toEqual([
      "-y",
      "chrome-devtools-mcp@1.10.1",
      "--browserUrl",
      "http://127.0.0.1:9333",
      "--no-usage-statistics",
    ]);
    const inline: McpServerConfig = {
      type: "stdio",
      command: "npx",
      args: ["chrome-devtools-mcp", "--browserUrl=http://localhost:9222"],
      env: {},
    };
    expect(browserUrlOf(inline)).toBe("http://localhost:9222");
    expect(browserUrlOf(withBrowserUrl(inline, "http://localhost:9444"))).toBe("http://localhost:9444");
  });
});

const fakeMcp = `
  const rl = require("readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
    if (msg.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "navigate_page" }] } }));
  });`;

function devtoolsConfig(url: string): McpServerConfig {
  return {
    type: "stdio",
    command: process.execPath,
    args: ["-e", fakeMcp, "chrome-devtools-mcp@1.10.1", "--browserUrl", url],
    env: {},
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP address");
  return address.port;
}

describe("browser check", () => {
  it("tells the user to start the browser with the debug port when nothing answers", async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise((resolve) => closed.close(resolve));
    const url = `http://127.0.0.1:${port}`;
    const result = await probeMcpServer({ config: devtoolsConfig(url) });
    expect(result).toEqual({
      ok: false,
      error: `Can't reach your browser at ${url}. Start Chrome, Brave or another Chromium browser with --remote-debugging-port=${port}, then test again.`,
    });
  });

  it("lists the tools once the browser answers on its debugging address", async () => {
    const browser = createServer((request, response) => {
      response.writeHead(request.url === "/json/version" ? 200 : 404, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "Chrome/140" }));
    });
    const port = await listen(browser);
    try {
      const result = await probeMcpServer({ config: devtoolsConfig(`http://127.0.0.1:${port}`) });
      expect(result).toEqual({ ok: true, tools: [{ name: "navigate_page", description: "" }] });
    } finally {
      browser.close();
    }
  });
});
