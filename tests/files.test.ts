import type * as FsPromises from "node:fs/promises";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { CommandAllowlist } from "../server/commands";
import { MemoryJournal } from "../server/journal";
import { createProposal, getProposal } from "../server/proposals";
import { useTempPaseoHome } from "./helpers";

const tearing = vi.hoisted(() => ({ path: null as string | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      const [path, data] = args;
      if (!tearing.path || !String(path).includes(tearing.path)) return actual.writeFile(...args);
      await actual.writeFile(path, String(data).slice(0, 20));
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    },
  };
});

async function store(name: string, text: string): Promise<void> {
  await mkdir(pluginDataPath(), { recursive: true });
  await writeFile(join(pluginDataPath(), name), text);
}

async function setAside(name: string): Promise<string[]> {
  const files = (await readdir(pluginDataPath())).filter((file) => file.startsWith(`${name}.corrupt-`));
  return Promise.all(files.map((file) => readFile(join(pluginDataPath(), file), "utf8")));
}

/** composio.ts caches its state, so each test loads a fresh copy. */
async function freshComposio() {
  vi.resetModules();
  return import("../server/composio");
}

describe("stored files", () => {
  useTempPaseoHome("paseo-bots-files-");

  afterEach(() => {
    tearing.path = null;
    vi.restoreAllMocks();
  });

  it("sets a torn composio.json aside instead of overwriting its user and secret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const torn = '{"apiKey": "ak_real", "userId": "paseo_bots_real", "secret": "s3cr';
    await store("composio.json", torn);
    const composio = await freshComposio();
    await composio.writeState({ port: 4321 });
    expect(await setAside("composio.json")).toEqual([torn]);
    const saved = JSON.parse(await readFile(join(pluginDataPath(), "composio.json"), "utf8"));
    expect(saved).toMatchObject({ port: 4321 });
    expect(saved.userId).not.toBe("paseo_bots_real");
  });

  it("sets a torn proposals.json aside instead of overwriting it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const torn = '{"proposals": [{"id": "p-0123456789", "status": "pend';
    await store("proposals.json", torn);
    const proposal = await createProposal({
      botId: "bot-1",
      agentId: "chat-1",
      kind: "skill",
      data: { name: "tea", description: "Tea", text: "# Tea\n" },
    });
    expect(await setAside("proposals.json")).toEqual([torn]);
    expect(await getProposal(proposal.id)).toEqual(proposal);
  });

  it("sets a torn commands.json aside instead of overwriting it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const torn = '{"version": 1, "rules": [{"id": "r-1", "command": "npm te';
    await store("commands.json", torn);
    const commands = new CommandAllowlist();
    const rule = await commands.add("bot-1", "npm test", "/work/app");
    expect(await setAside("commands.json")).toEqual([torn]);
    expect(await commands.list("bot-1")).toEqual([rule]);
  });

  it("keeps the old commands.json when writing the new one fails", async () => {
    const commands = new CommandAllowlist();
    const rule = await commands.add("bot-w", "make", "/work/app");
    tearing.path = "commands.json";
    await expect(commands.add("bot-w", "make test", "/work/app")).rejects.toThrow("ENOSPC");
    tearing.path = null;
    expect(await commands.list("bot-w")).toEqual([rule]);
    expect((await readdir(pluginDataPath())).filter((file) => file.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps the memory journal when writing it fails", async () => {
    const journal = new MemoryJournal();
    await journal.write("bot-j", "MEMORY.md", "# Memory\n- likes tea\n");
    tearing.path = "journal";
    await expect(journal.write("bot-j", "MEMORY.md", "# Memory\n- likes coffee\n")).rejects.toThrow("ENOSPC");
    tearing.path = null;
    expect((await journal.list("bot-j")).map((entry) => entry.kind)).toEqual(["created"]);
  });
});

describe("an unreadable composio.json", () => {
  useTempPaseoHome("paseo-bots-files-unreadable-");

  it("refuses to replace a composio.json it can't read", async () => {
    const path = join(pluginDataPath(), "composio.json");
    await mkdir(join(path, "inside"), { recursive: true });
    const composio = await freshComposio();
    await expect(composio.readState()).rejects.toThrow();
    await expect(composio.writeState({ port: 1 })).rejects.toThrow();
    expect(await readdir(path)).toEqual(["inside"]);
  });
});
