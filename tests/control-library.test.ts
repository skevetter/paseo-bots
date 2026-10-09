import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type * as Os from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LIBRARY_TOOLS } from "../server/control/tools/library";
import { readSkill } from "../server/library";
import { acceptProposal, getProposal } from "../server/proposals";
import { type BotState, EMPTY_LIBRARY, type LibraryMcpServer, type LibrarySkill } from "../shared/bot";
import { BROWSER_SERVER_ID } from "../shared/browser";
import { startControl } from "./control-helpers";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";

const machine = vi.hoisted(() => ({ home: "" }));

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof Os>();
  return { ...os, homedir: () => machine.home || os.homedir() };
});

const running: { stop(): Promise<void> }[] = [];

async function control(
  seed?: Parameters<typeof startControl>[1],
  settings?: Parameters<typeof startControl>[2],
) {
  const started = await startControl(LIBRARY_TOOLS, seed, settings);
  running.push(started);
  return started;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

function server(patch: Partial<LibraryMcpServer> = {}): LibraryMcpServer {
  return {
    id: "mcp-fetch",
    name: "fetch",
    description: "",
    enabled: false,
    config: { type: "stdio", command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "sk-secret-1" } },
    tools: null,
    checkedAt: null,
    checkError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

function skill(patch: Partial<LibrarySkill> = {}): LibrarySkill {
  return {
    id: "notes",
    description: "d",
    source: "",
    enabled: true,
    reviewedSha: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const fakeServer = `
  const rl = require("readline").createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } } }));
    if (msg.method === "tools/list") console.log(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "Echoes" }] } }));
  });`;
const workingConfig = { command: process.execPath, args: ["-e", fakeServer] };

async function stored(store: { read(): Promise<{ values: BotState }> }) {
  const { values } = await store.read();
  return { library: values.library ?? EMPTY_LIBRARY, bots: values.bots };
}

describe("MCP server reads and adds", () => {
  useTempPaseoHome("paseo-bots-control-library-");

  it("lists every server with the built-in Browser and masks env and header values", async () => {
    const remote = server({
      id: "mcp-docs",
      name: "docs",
      config: {
        type: "http",
        url: "https://docs.example/mcp",
        headers: { Authorization: "Bearer hdr-secret" },
      },
    });
    const { call } = await control({
      bots: [makeBot({ mcpServerIds: ["mcp-fetch"] })],
      library: { skills: [], mcpServers: [server(), remote] },
    });

    const listed = await call("mcp_servers_list");
    const servers = listed.data.servers as { id: string; config: Record<string, unknown>; bots: unknown[] }[];
    expect(servers.map((entry) => entry.id)).toEqual(["mcp-fetch", "mcp-docs", BROWSER_SERVER_ID]);
    expect(servers[0]?.config).toMatchObject({ env: { TOKEN: "•••" } });
    expect(servers[0]?.bots).toEqual([{ id: "bot-1", name: "Inbox" }]);
    expect(servers[1]?.config).toMatchObject({ headers: { Authorization: "•••" } });

    const got = await call("mcp_servers_get", { server: "docs" });
    for (const answer of [listed, got]) {
      expect(JSON.stringify(answer)).not.toMatch(/sk-secret-1|hdr-secret/);
    }
    expect(got.data.server).toMatchObject({ id: "mcp-docs", target: "HTTP · https://docs.example/mcp" });
  });

  it("waits for approval to add a server, then adds it off and untested; refuses bad names", async () => {
    const { call, store, context } = await control({ library: { skills: [], mcpServers: [server()] } });

    const added = await call("mcp_servers_add", {
      name: "search",
      description: " Finds things ",
      config: { url: "https://search.example/mcp", transport: "sse", headers: { "X-Key": "k1" } },
    });
    expect(added.data).toMatchObject({
      status: "pending",
      reasons: [expect.stringContaining("search.example")],
    });
    expect((await stored(store)).library.mcpServers.map((entry) => entry.name)).toEqual(["fetch"]);
    await acceptProposal(String(added.data.proposal), { store, commands: context.commands });
    const { library } = await stored(store);
    expect(library.mcpServers.find((entry) => entry.name === "search")).toMatchObject({
      description: "Finds things",
      enabled: false,
      tools: null,
      config: { type: "sse", url: "https://search.example/mcp", headers: { "X-Key": "k1" } },
    });

    for (const name of ["paseo", "fetch"]) {
      const refused = await call("mcp_servers_add", { name, config: { command: "x" } });
      expect(refused.isError).toBe(true);
    }
    expect((await call("mcp_servers_add", { name: "has space", config: { command: "x" } })).isError).toBe(
      true,
    );
    const both = await call("mcp_servers_add", {
      name: "both",
      config: { command: "x", url: "https://a.example" },
    });
    expect(both.isError).toBe(true);
    const masked = await call("mcp_servers_add", {
      name: "masked",
      config: { command: "x", env: { A: "•••" } },
    });
    expect(masked).toMatchObject({ isError: true, text: expect.stringContaining("A has no value yet") });
    expect((await stored(store)).library.mcpServers.map((entry) => entry.name)).toEqual(["fetch", "search"]);
  });

  it("adds a server at once when elevated changes are allowed", async () => {
    const { call, store } = await control({}, { allowElevated: true });
    const added = await call("mcp_servers_add", { name: "local", config: { command: "uvx", args: ["x"] } });
    expect(added.data).toMatchObject({
      status: "applied",
      servers: [expect.objectContaining({ name: "local" })],
    });
    expect((await stored(store)).library.mcpServers.map((entry) => [entry.name, entry.enabled])).toEqual([
      ["local", false],
    ]);
  });
});

describe("MCP server tests", () => {
  useTempPaseoHome("paseo-bots-control-probe-");

  it("probes a local server, records its tools, and turns it on only when asked", async () => {
    const { call, store } = await control({
      library: { skills: [], mcpServers: [server({ config: { type: "stdio", ...workingConfig, env: {} } })] },
    });

    const tested = await call("mcp_servers_probe", { server: "fetch" });
    expect(tested.data).toMatchObject({
      status: "connected",
      tools: [{ name: "echo", description: "Echoes" }],
    });
    expect((await stored(store)).library.mcpServers[0]).toMatchObject({ enabled: false, checkError: null });

    await call("mcp_servers_probe", { server: "fetch", enable: true });
    const on = (await stored(store)).library.mcpServers[0];
    expect(on).toMatchObject({ enabled: true, tools: [{ name: "echo" }] });
    expect(on?.checkedAt).not.toBeNull();
  });

  it("records a failed probe and leaves the server off", async () => {
    const { call, store } = await control({
      library: {
        skills: [],
        mcpServers: [
          server({ config: { type: "stdio", command: "definitely-not-a-command-xyz", args: [], env: {} } }),
        ],
      },
    });
    const failed = await call("mcp_servers_probe", { server: "fetch", enable: true });
    expect(failed.data.status).toBe("failed");
    const entry = (await stored(store)).library.mcpServers[0];
    expect(entry?.enabled).toBe(false);
    expect(entry?.checkError).toBeTruthy();
  });
});

describe("MCP server updates", () => {
  useTempPaseoHome("paseo-bots-control-update-");

  it("updates a server: only a tested one turns on, a rename carries grants, a new connection is retested", async () => {
    const { call, store } = await control(
      {
        bots: [makeBot({ mcpServerIds: ["mcp-fetch"], alwaysAllow: ["fetch/get", "other/run"] })],
        library: { skills: [], mcpServers: [server()] },
      },
      { allowElevated: true },
    );

    const untested = await call("mcp_servers_update", { server: "fetch", enabled: true });
    expect(untested).toMatchObject({ isError: true, text: expect.stringContaining("connection test") });

    await call("mcp_servers_update", { server: "fetch", name: "web", description: "The web" });
    let state = await stored(store);
    expect(state.library.mcpServers[0]).toMatchObject({
      name: "web",
      description: "The web",
      enabled: false,
    });
    expect(state.bots[0]?.alwaysAllow).toEqual(["web/get", "other/run"]);
    expect((await call("mcp_servers_update", { server: "web", name: "paseo" })).isError).toBe(true);

    const sameTarget = { command: "uvx", args: ["mcp-server-fetch"], env: { TOKEN: "•••" } };
    await call("mcp_servers_update", { server: "web", config: sameTarget });
    expect((await stored(store)).library.mcpServers[0]?.config).toMatchObject({
      env: { TOKEN: "sk-secret-1" },
    });
    const moved = await call("mcp_servers_update", {
      server: "web",
      enabled: true,
      config: { ...workingConfig, env: { TOKEN: "•••", EXTRA: "e" } },
    });
    expect(moved).toMatchObject({
      isError: true,
      text: expect.stringContaining("TOKEN needs its value again"),
    });

    const retested = await call("mcp_servers_update", {
      server: "web",
      enabled: true,
      config: { ...workingConfig, env: { TOKEN: "sk-secret-2", EXTRA: "e" } },
    });
    expect(retested.data).toMatchObject({ status: "applied", test: { ok: true } });
    state = await stored(store);
    expect(state.library.mcpServers[0]).toMatchObject({
      enabled: true,
      tools: [{ name: "echo" }],
      config: { command: process.execPath, env: { TOKEN: "sk-secret-2", EXTRA: "e" } },
    });
    expect(JSON.stringify(retested)).not.toContain("sk-secret-2");

    await call("mcp_servers_update", { server: "web", enabled: false });
    expect((await stored(store)).library.mcpServers[0]?.enabled).toBe(false);
  });

  it("refuses a new connection unless elevated changes are allowed", async () => {
    const devtools = { command: process.execPath, args: ["-e", "process.exit(1)", "chrome-devtools-mcp"] };
    const seed = {
      bots: [makeBot({ mcpServerIds: ["mcp-fetch"] })],
      library: { skills: [], mcpServers: [server()] },
    };
    const held = await control(seed);
    const refused = await held.call("mcp_servers_update", { server: "fetch", config: devtools });
    expect(refused).toMatchObject({ isError: true, text: expect.stringContaining("Change it in the app") });
    expect((await stored(held.store)).library.mcpServers[0]?.config).toMatchObject({
      args: ["mcp-server-fetch"],
    });

    const allowed = await control(seed, { allowElevated: true });
    const applied = await allowed.call("mcp_servers_update", { server: "fetch", config: devtools });
    expect(applied.data.status).toBe("applied");
    expect((await stored(allowed.store)).library.mcpServers[0]?.config).toMatchObject({
      args: devtools.args,
    });
  });
});

describe("MCP server attach and remove", () => {
  useTempPaseoHome("paseo-bots-control-attach-");

  it("attaches and detaches a server, saying when it's off", async () => {
    const { call, store } = await control({
      bots: [makeBot()],
      library: { skills: [], mcpServers: [server()] },
    });
    const attached = await call("mcp_servers_attach", { server: "fetch", bot: "Inbox" });
    expect(attached.text).toContain("is off");
    expect((await stored(store)).bots[0]?.mcpServerIds).toEqual(["mcp-fetch"]);

    await call("mcp_servers_detach", { server: "mcp-fetch", bot: "bot-1" });
    expect((await stored(store)).bots[0]?.mcpServerIds).toEqual([]);
  });

  it("puts a Browser attach up for approval, and applies it when elevated changes are allowed", async () => {
    const { call, store, toggles } = await control({ bots: [makeBot()] });

    const pending = await call("mcp_servers_attach", { server: BROWSER_SERVER_ID, bot: "Inbox" });
    expect(pending.data).toMatchObject({ status: "pending", proposal: expect.any(String) });
    expect((await getProposal(String(pending.data.proposal)))?.status).toBe("pending");
    let state = await stored(store);
    expect(state.bots[0]?.mcpServerIds).toEqual([]);
    expect(state.library.mcpServers.map((entry) => entry.id)).toEqual([BROWSER_SERVER_ID]);

    toggles.allowElevated = true;
    const applied = await call("mcp_servers_attach", { server: "browser", bot: "Inbox" });
    expect(applied.data.status).toBe("applied");
    state = await stored(store);
    expect(state.bots[0]?.mcpServerIds).toEqual([BROWSER_SERVER_ID]);
  });

  it("removes a server only with confirm, taking it and its grants off every bot", async () => {
    const { call, store } = await control({
      bots: [makeBot({ mcpServerIds: ["mcp-fetch"], alwaysAllow: ["fetch/get", "other/run"] })],
      library: { skills: [], mcpServers: [server()] },
    });

    expect((await call("mcp_servers_remove", { server: "fetch" })).isError).toBe(true);
    expect((await stored(store)).library.mcpServers).toHaveLength(1);

    const removed = await call("mcp_servers_remove", { server: "fetch", confirm: true });
    expect(removed.data).toEqual({ removed: "mcp-fetch" });
    const state = await stored(store);
    expect(state.library.mcpServers.map((entry) => entry.id)).toEqual([BROWSER_SERVER_ID]);
    expect(state.bots[0]).toMatchObject({ mcpServerIds: [], alwaysAllow: ["other/run"] });

    const browser = await call("mcp_servers_remove", { server: BROWSER_SERVER_ID, confirm: true });
    expect(browser.isError).toBe(true);
  });
});

describe("MCP server import", () => {
  useTempPaseoHome("paseo-bots-control-import-");
  beforeAll(async () => {
    machine.home = await mkdtemp(join(tmpdir(), "paseo-bots-control-mcp-home-"));
    const path = join(machine.home, ".cursor", "mcp.json");
    await mkdir(join(machine.home, ".cursor"), { recursive: true });
    await writeFile(path, JSON.stringify({ mcpServers: { linear: { url: "https://mcp.linear.app/sse" } } }));
  });
  afterAll(async () => {
    await rm(machine.home, { recursive: true, force: true });
    machine.home = "";
  });

  it("imports servers off from JSON or another app's setup, after approval", async () => {
    const { call, store, context } = await control({ library: { skills: [], mcpServers: [server()] } });

    const sources = await call("mcp_servers_sources");
    expect(sources.data.sources).toEqual([{ label: "Cursor", servers: ["linear"] }]);

    const fromCursor = await call("mcp_servers_import", { from: "cursor" });
    expect(fromCursor.data).toMatchObject({
      status: "pending",
      reasons: [expect.stringContaining("linear")],
    });
    await acceptProposal(String(fromCursor.data.proposal), { store, commands: context.commands });
    const json = JSON.stringify({ mcpServers: { fetch: { command: "npx", args: ["other"] } } });
    const imported = await call("mcp_servers_import", { json });
    await acceptProposal(String(imported.data.proposal), { store, commands: context.commands });
    const { library } = await stored(store);
    expect(library.mcpServers.map((entry) => [entry.name, entry.enabled])).toEqual([
      ["fetch", false],
      ["linear", false],
      ["fetch-2", false],
    ]);
    expect((await call("mcp_servers_import", { json })).data.status).toBe("pending");
    expect((await call("mcp_servers_import", { from: "Nowhere" })).isError).toBe(true);
    expect((await call("mcp_servers_import", {})).isError).toBe(true);
  });
});

const realFetch = globalThis.fetch;
/** Answers like the skill links given, and passes the control endpoint's own requests through. */
function serveLinks(links: Record<string, string>) {
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const text = links[url];
    return text === undefined ? new Response("Not Found", { status: 404 }) : new Response(text);
  });
}
const link = "https://example.com/kits/report/SKILL.md";
const skillMd = (description: string) => `---\nname: report\ndescription: ${description}\n---\n\nSteps.\n`;

describe("skill import and review", () => {
  useTempPaseoHome("paseo-bots-control-skills-");

  it("imports a skill off for review, reads it, and approves exactly what was read", async () => {
    serveLinks({ [link]: skillMd("Weekly report") });
    const { call, store } = await control({ bots: [makeBot()] });

    const imported = await call("skills_import", { source: link });
    expect(imported.text).toContain("Review it");
    expect((await stored(store)).library.skills[0]).toMatchObject({
      id: "report",
      source: link,
      enabled: false,
      reviewedSha: null,
    });

    const read = await call("skills_read", { skill: "report" });
    expect(read.data).toMatchObject({ text: skillMd("Weekly report"), skill: { needsReview: true } });
    const sha = String(read.data.sha);

    expect((await call("skills_set_enabled", { skill: "report", enabled: true })).isError).toBe(true);
    expect((await call("skills_review", { skill: "report", sha: "0".repeat(64) })).isError).toBe(true);
    const reviewed = await call("skills_review", { skill: "report", sha });
    expect(reviewed.data.skill).toMatchObject({ enabled: true, needsReview: false, active: true });
    expect((await stored(store)).library.skills[0]?.reviewedSha).toBe(sha);

    await call("skills_set_enabled", { skill: "report", enabled: false });
    expect((await stored(store)).library.skills[0]?.enabled).toBe(false);
    await call("skills_set_enabled", { skill: "report", enabled: true });

    serveLinks({ [link]: skillMd("Monthly report") });
    const updated = await call("skills_import", { skill: "report" });
    expect(updated.data.skills).toEqual([
      expect.objectContaining({ description: "Monthly report", needsReview: true }),
    ]);
    expect((await call("skills_import", { source: link, skill: "report" })).isError).toBe(true);
  });
});

describe("skill writes, attaching and deleting", () => {
  useTempPaseoHome("paseo-bots-control-skill-files-");

  it("writes a skill as reviewed, warns about missing frontmatter, and reads it back", async () => {
    const { call, store } = await control({
      library: { skills: [skill({ enabled: false })], mcpServers: [] },
    });

    const created = await call("skills_write", {
      id: "weekly",
      text: skillMd("Weekly").replace("report", "weekly"),
    });
    expect(created.data.skill).toMatchObject({
      id: "weekly",
      description: "Weekly",
      enabled: true,
      active: true,
    });
    const written = (await stored(store)).library.skills.find((entry) => entry.id === "weekly");
    expect(written?.reviewedSha).toBe(created.data.sha);

    const edited = await call("skills_write", { id: "notes", text: "Just steps." });
    expect(edited.text).toContain("Add a description");
    expect((await stored(store)).library.skills[0]).toMatchObject({
      id: "notes",
      enabled: false,
      reviewedSha: edited.data.sha,
    });
    expect((await call("skills_read", { skill: "notes" })).data).toMatchObject({
      text: "Just steps.",
      missing: false,
    });
    expect((await call("skills_write", { id: "../escape", text: "x" })).isError).toBe(true);

    const listed = await call("skills_list");
    expect((listed.data.skills as { id: string }[]).map((entry) => entry.id)).toEqual(["notes", "weekly"]);
  });

  it("attaches, detaches and deletes a skill, deleting only with confirm", async () => {
    const { call, store } = await control({ bots: [makeBot()] });
    await call("skills_write", { id: "notes", text: skillMd("Notes").replace("report", "notes") });

    const attached = await call("skills_attach", { skill: "notes", bot: "Inbox" });
    expect(attached.data).toMatchObject({
      status: "applied",
      skill: { bots: [{ id: "bot-1", name: "Inbox" }] },
    });
    expect((await stored(store)).bots[0]?.skillIds).toEqual(["notes"]);
    await call("skills_detach", { skill: "notes", bot: "Inbox" });
    expect((await stored(store)).bots[0]?.skillIds).toEqual([]);

    await call("skills_attach", { skill: "notes", bot: "Inbox" });
    expect((await call("skills_delete", { skill: "notes" })).isError).toBe(true);
    expect((await readSkill({ id: "notes" })).missing).toBe(false);

    const deleted = await call("skills_delete", { skill: "notes", confirm: true });
    expect(deleted.data).toEqual({ removed: "notes" });
    const state = await stored(store);
    expect(state.library.skills).toEqual([]);
    expect(defined(state.bots[0]).skillIds).toEqual([]);
    expect((await readSkill({ id: "notes" })).missing).toBe(true);
  });
});
