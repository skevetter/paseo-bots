import { describe, expect, it } from "vitest";
import type { BotState, LibraryMcpServer } from "../shared/bot";
import { BROWSER_SERVER_ID } from "../shared/browser";
import { elevations, importElevations, proposalElevations } from "../shared/elevated";
import type { Proposal } from "../shared/proposals";
import { makeBot, NOW } from "./helpers";

function server(id: string, args: string[]): LibraryMcpServer {
  return {
    id,
    name: id,
    description: "",
    enabled: true,
    config: { type: "stdio", command: "npx", args, env: {} },
    tools: [],
    checkedAt: NOW,
    checkError: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const browser = server(BROWSER_SERVER_ID, ["-y", "chrome-devtools-mcp@1.10.1"]);
const fetcher = server("mcp-fetch", ["mcp-server-fetch"]);

function state(patch: Partial<BotState> = {}): BotState {
  return {
    bots: [makeBot({ id: "a", name: "Ada" })],
    history: [],
    library: { skills: [], mcpServers: [browser, fetcher] },
    ...patch,
  };
}

describe("elevated changes", () => {
  it("flags a bot that newly gets the Browser server or a mode that doesn't ask", () => {
    const before = state();
    const browsing = state({ bots: [makeBot({ id: "a", name: "Ada", mcpServerIds: [BROWSER_SERVER_ID] })] });
    expect(elevations(before, browsing)).toEqual([expect.stringContaining("Browser server")]);
    expect(elevations(browsing, browsing)).toEqual([]);
    const bypass = state({ bots: [makeBot({ id: "a", name: "Ada", modeId: "bypassPermissions" })] });
    expect(elevations(before, bypass)).toEqual([expect.stringContaining('"bypassPermissions"')]);
    const tiered = state({ bots: [makeBot({ id: "a", name: "Ada", modeId: "auto" })] });
    expect(
      elevations(before, tiered, { claude: { modes: [{ id: "auto", colorTier: "dangerous" }] } }),
    ).toHaveLength(1);
    expect(
      elevations(before, state({ bots: [makeBot({ id: "a", name: "Ada", mcpServerIds: ["mcp-fetch"] })] })),
    ).toEqual([]);
    const dangerousDefault = {
      claude: { modes: [{ id: "auto", colorTier: "dangerous" }], defaultModeId: "auto" },
    };
    const fresh = state({ bots: [makeBot({ id: "a", name: "Ada" }), makeBot({ id: "b", name: "Bea" })] });
    expect(elevations(before, fresh, dangerousDefault)).toEqual([]);
  });

  it("flags an attached server that turns into the Browser server, and defaults that don't ask", () => {
    const attached = state({ bots: [makeBot({ id: "a", name: "Ada", mcpServerIds: ["mcp-fetch"] })] });
    const swapped = {
      ...attached,
      library: { skills: [], mcpServers: [browser, server("mcp-fetch", ["chrome-devtools-mcp"])] },
    };
    expect(elevations(attached, swapped)).toEqual([expect.stringContaining("Browser server")]);
    const defaults = { provider: "claude", model: null, modeId: "bypassPermissions", thinkingOptionId: null };
    expect(elevations(state(), state({ defaults: { ...defaults, contactBots: "ask" } }))).toEqual([
      expect.stringContaining("New bots start"),
    ]);
  });

  it("flags imports that bring MCP servers or bots that don't ask, and every command", () => {
    const plain = { bot: makeBot({ id: "b", name: "Bea" }), skills: [], mcpServers: [] };
    expect(importElevations(state(), { bots: [plain], teams: [] })).toEqual([]);
    const carrying = { ...plain, mcpServers: [{ name: "gh", enabled: true, config: fetcher.config }] };
    expect(importElevations(state(), { bots: [carrying], teams: [] })).toEqual([
      expect.stringContaining("gh"),
    ]);
    const copy = { ...plain, bot: makeBot({ id: "b", name: "Bea", mcpServerIds: [BROWSER_SERVER_ID] }) };
    expect(importElevations(state(), { bots: [copy], teams: [] })).toEqual([
      expect.stringContaining("Browser"),
    ]);
    const command = {
      id: "p-1",
      botId: "a",
      agentId: "",
      origin: "control",
      status: "pending",
      createdAt: NOW,
      resolvedAt: null,
      kind: "command",
      data: { command: "rm -rf /tmp/x", cwd: "/tmp" },
    } satisfies Proposal;
    expect(proposalElevations(command, state())).toHaveLength(1);
  });
});
