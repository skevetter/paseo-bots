import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { TEAM_TOOLS } from "../server/control/tools/teams";
import { acceptProposal, getProposal } from "../server/proposals";
import type { BotGroup, LibraryMcpServer } from "../shared/bot";
import { startControl } from "./control-helpers";
import { makeBot, NOW, useTempPaseoHome } from "./helpers";

const running: { stop(): Promise<void> }[] = [];
const folders: string[] = [];

async function control(...args: Parameters<typeof startControl>) {
  const started = await startControl(...args);
  running.push(started);
  return started;
}

async function tempFolder() {
  const folder = await mkdtemp(join(tmpdir(), "paseo-bots-share-"));
  folders.push(folder);
  return folder;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const ada = makeBot({ id: "bot-ada", name: "Ada" });
const bob = makeBot({ id: "bot-bob", name: "Bob" });
const cy = makeBot({ id: "bot-cy", name: "Cy" });
const old = makeBot({ id: "bot-old", name: "Old", archived: true });

const crew: BotGroup = {
  id: "team-crew",
  name: "Crew",
  logo: null,
  leadId: "bot-ada",
  memberIds: ["bot-ada", "bot-bob"],
  instructions: "Be brief.",
  createdAt: NOW,
  updatedAt: NOW,
};

const notes: LibraryMcpServer = {
  id: "notes",
  name: "notes",
  description: "",
  enabled: true,
  config: { type: "http", url: "https://notes.example", headers: { Authorization: "Bearer secret" } },
  tools: null,
  checkedAt: null,
  checkError: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const Named = z.array(z.object({ name: z.string() }));
const names = (bots: unknown) => Named.parse(bots).map((bot) => bot.name);
const memberNames = (team: unknown) => names(z.object({ members: z.unknown() }).parse(team).members);

describe("team control tools", () => {
  useTempPaseoHome("paseo-bots-control-teams-");

  it("creates, lists, updates and deletes teams, moving a bot off its other team", async () => {
    const { call, store } = await control(TEAM_TOOLS, { bots: [ada, bob, cy] });

    const created = await call("teams_create", { name: "Ops", lead: "Ada", members: ["Bob"] });
    expect(created.isError).toBe(false);
    expect(created.data.team).toMatchObject({ name: "Ops", lead: { name: "Ada" } });
    expect(memberNames(created.data.team)).toEqual(["Ada", "Bob"]);

    await call("teams_create", { name: "Lab", members: ["Bob"] });
    const listed = await call("teams_list");
    const teams = z.array(z.object({ name: z.string() }).passthrough()).parse(listed.data.teams);
    expect(teams.map((team) => [team.name, memberNames(team)])).toEqual([
      ["Ops", ["Ada"]],
      ["Lab", ["Bob"]],
    ]);
    const updated = await call("teams_update", {
      team: "Ops",
      name: "Operations",
      lead: null,
      add_members: ["Cy"],
      instructions: "  Reply in English.  ",
    });
    expect(updated.data.team).toMatchObject({
      name: "Operations",
      lead: null,
      instructions: "Reply in English.",
    });
    expect(memberNames(updated.data.team)).toEqual(["Ada", "Cy"]);

    const unconfirmed = await call("teams_delete", { team: "Operations" });
    expect(unconfirmed.isError).toBe(true);
    expect((await store.read()).values.groups?.map((group) => group.name)).toEqual(["Operations", "Lab"]);

    const deleted = await call("teams_delete", { team: "Operations", confirm: true });
    expect(deleted.isError).toBe(false);
    const { values } = await store.read();
    expect(values.groups?.map((group) => group.name)).toEqual(["Lab"]);
    expect(values.bots.map((bot) => bot.name)).toEqual(["Ada", "Bob", "Cy"]);
  });

  it("names the known teams when one isn't found", async () => {
    const { call } = await control(TEAM_TOOLS, { bots: [ada], groups: [crew] });
    const missing = await call("teams_update", { team: "Nope", name: "X" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("Crew");
  });
});

describe("bot export and import control tools", () => {
  useTempPaseoHome("paseo-bots-control-share-");

  it("exports one bot as a bot file and every live bot as a team file", async () => {
    const { call } = await control(TEAM_TOOLS, { bots: [ada, bob, old], groups: [crew] });

    const one = await call("bots_export", { bots: ["Ada"] });
    expect(one.data).toMatchObject({ kind: "bot", bots: ["Ada"] });
    expect(JSON.parse(String(one.data.json)).bot.name).toBe("Ada");

    const all = await call("bots_export");
    expect(all.data).toMatchObject({ kind: "team", bots: ["Ada", "Bob"] });
    const file = JSON.parse(String(all.data.json));
    expect(file.teams).toEqual([expect.objectContaining({ name: "Crew", lead: 0, members: [0, 1] })]);
  });

  it("writes the file to an absolute path, and refuses a relative one", async () => {
    const { call } = await control(TEAM_TOOLS, { bots: [ada, bob] });
    const path = join(await tempFolder(), "nested", "team.json");

    const saved = await call("bots_export", { bots: ["Ada", "Bob"], path });
    expect(saved.data).toMatchObject({ kind: "team", path });
    expect(saved.data.json).toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8")).bots).toHaveLength(2);

    expect((await call("bots_export", { path: "team.json" })).isError).toBe(true);
  });

  it("imports a file without MCP servers right away, numbering a name in use", async () => {
    const { call, store } = await control(TEAM_TOOLS, { bots: [ada, bob], groups: [crew] });
    const path = join(await tempFolder(), "team.json");
    await call("bots_export", { path });

    const imported = await call("bots_import", { path });
    expect(imported.data).toMatchObject({ status: "applied", teams: ["Crew"] });
    expect(imported.text).toContain("Ada 2, Bob 2");
    const { values } = await store.read();
    expect(values.bots).toHaveLength(4);
    expect(values.groups?.map((group) => group.name)).toEqual(["Crew", "Crew"]);
    expect(names(imported.data.bots)).toEqual(["Ada 2", "Bob 2"]);
  });

  it("takes exactly one of json or path", async () => {
    const { call } = await control(TEAM_TOOLS, { bots: [ada] });
    expect((await call("bots_import", {})).isError).toBe(true);
    expect((await call("bots_import", { json: "{}", path: "/tmp/team.json" })).isError).toBe(true);
    const damaged = await call("bots_import", { json: "{}" });
    expect(damaged.isError).toBe(true);
    expect(damaged.text).toContain("paseo-bots export");
  });

  async function serverFile() {
    const seeded = await control(TEAM_TOOLS, {
      bots: [makeBot({ id: "bot-n", name: "Noter", mcpServerIds: ["notes"] })],
      library: { skills: [], mcpServers: [notes] },
    });
    return String((await seeded.call("bots_export")).data.json);
  }

  it("holds a file that brings MCP servers for approval, and accepting it adds the bot", async () => {
    const json = await serverFile();
    const { call, store, context } = await control(TEAM_TOOLS, { bots: [ada] });

    const pending = await call("bots_import", { json });
    expect(pending.data.status).toBe("pending");
    expect(pending.text).toContain("notes");
    expect((await store.read()).values.bots.map((bot) => bot.name)).toEqual(["Ada"]);

    const id = String(pending.data.proposal);
    expect((await getProposal(id))?.kind).toBe("import");
    await acceptProposal(id, { store, commands: context.commands });
    const { values } = await store.read();
    expect(values.bots.map((bot) => bot.name)).toEqual(["Ada", "Noter"]);
    expect(values.library?.mcpServers.map(({ name, enabled }) => ({ name, enabled }))).toEqual([
      { name: "notes", enabled: false },
    ]);
  });

  it("imports a file with MCP servers right away when elevated changes are allowed", async () => {
    const json = await serverFile();
    const { call, store } = await control(TEAM_TOOLS, { bots: [ada] }, { allowElevated: true });

    const imported = await call("bots_import", { json });
    expect(imported.data.status).toBe("applied");
    expect((await store.read()).values.bots.map((bot) => bot.name)).toEqual(["Ada", "Noter"]);
  });
});
