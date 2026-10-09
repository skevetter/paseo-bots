import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpSources } from "../server/mcp-sources";
import { parseMcpJson } from "../shared/mcp-servers";

import { defined } from "./helpers";

const machine = vi.hoisted(() => ({ home: "", platform: "darwin" as NodeJS.Platform }));

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof Os>();
  return { ...os, homedir: () => machine.home, platform: () => machine.platform };
});

const servers = {
  fetch: { command: "uvx", args: ["mcp-server-fetch"] },
  docs: { url: "https://docs.example" },
};

async function place(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const found = async () => (await mcpSources()).sources.map((source) => [source.label, source.count]);

describe("mcpSources", () => {
  const appData = process.env.APPDATA;
  beforeEach(async () => {
    machine.home = await mkdtemp(join(tmpdir(), "paseo-bots-mcp-home-"));
    machine.platform = "darwin";
  });
  afterEach(async () => {
    if (appData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = appData;
    await rm(machine.home, { recursive: true, force: true });
  });

  it("reads each app's servers from where it keeps them on a Mac", async () => {
    const desktop = join(
      machine.home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    // Servers scoped to one project stay out; only the user-wide list is offered.
    await place(
      join(machine.home, ".claude.json"),
      JSON.stringify({
        projects: { "/x": { mcpServers: { local: { command: "a" } } } },
        mcpServers: { fetch: servers.fetch },
      }),
    );
    await place(desktop, JSON.stringify({ mcpServers: servers }));
    await place(
      join(machine.home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { docs: servers.docs } }),
    );

    const { sources } = await mcpSources();

    expect(sources.map((source) => [source.label, source.count])).toEqual([
      ["Claude Code", 1],
      ["Claude Desktop", 2],
      ["Cursor", 1],
    ]);
    const desktopServers = parseMcpJson(defined(sources[1], "Claude Desktop source").json);
    expect(desktopServers.map((server) => [server.name, server.config.type])).toEqual([
      ["fetch", "stdio"],
      ["docs", "http"],
    ]);
  });

  it("finds Claude Desktop in the Linux config folder", async () => {
    machine.platform = "linux";
    await place(
      join(machine.home, ".config", "Claude", "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: servers }),
    );
    expect(await found()).toEqual([["Claude Desktop", 2]]);
  });

  it("finds Claude Desktop in AppData on Windows, with or without APPDATA set", async () => {
    machine.platform = "win32";
    const roaming = join(machine.home, "Roaming-Elsewhere");
    await place(
      join(roaming, "Claude", "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: servers }),
    );
    await place(
      join(machine.home, "AppData", "Roaming", "Claude", "claude_desktop_config.json"),
      JSON.stringify({ mcpServers: { fetch: servers.fetch } }),
    );

    process.env.APPDATA = roaming;
    expect(await found()).toEqual([["Claude Desktop", 2]]);
    delete process.env.APPDATA;
    expect(await found()).toEqual([["Claude Desktop", 1]]);
  });

  it("skips configs that are missing, garbled, or have no servers", async () => {
    const desktop = join(
      machine.home,
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
    const cursor = join(machine.home, ".cursor", "mcp.json");
    const claude = join(machine.home, ".claude.json");
    await place(cursor, "{ not json");
    for (const text of ["null", "[]", '{"mcpServers":[]}', '{"mcpServers":"x"}', '{"mcpServers":{}}', "{}"]) {
      await place(claude, text);
      await place(desktop, text);
      expect(await found(), text).toEqual([]);
    }
  });
});
