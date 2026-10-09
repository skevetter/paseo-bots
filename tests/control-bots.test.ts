import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { BOTS_TOOLS } from "../server/control/tools/bots";
import { acceptProposal, getProposal } from "../server/proposals";
import type { BotGroup, BotState, Preset } from "../shared/bot";
import { startControl } from "./control-helpers";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";

const running: { stop(): Promise<void> }[] = [];

const ada = makeBot({
  id: "bot-ada",
  name: "Ada",
  title: "Analyst",
  soul: "Answer with numbers.",
  pinned: true,
  skillIds: ["triage"],
  alwaysAllow: ["github/search"],
  cwd: "/tmp/ada",
});
const old = makeBot({ id: "bot-old", name: "Old", archived: true });
const team: BotGroup = {
  id: "team-1",
  name: "Desk",
  logo: null,
  leadId: "bot-ada",
  memberIds: ["bot-ada"],
  instructions: "",
  createdAt: NOW,
  updatedAt: NOW,
};
const EARLIER = "2026-01-01T00:00:00.000Z";
const Id = z.object({ id: z.string() });
const Listed = z.object({ bots: z.array(Id) });
const SavedBot = z.object({ bot: Id });
const SavedPreset = z.object({ preset: Id });
const Pending = z.object({ proposal: z.string() });

async function control(seed: Partial<BotState> = {}, settings: { allowElevated?: boolean } = {}) {
  const started = await startControl(BOTS_TOOLS, { bots: [ada, old], groups: [team], ...seed }, settings);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

describe("listing and creating bots", () => {
  useTempPaseoHome("paseo-bots-control-bots-");

  it("lists bots, with archived ones on request, and gets one with its system prompt", async () => {
    const { call } = await control();
    const listed = await call("bots_list");
    expect(listed.data.bots).toEqual([
      expect.objectContaining({ id: "bot-ada", name: "Ada", pinned: true, archived: false, team: "Desk" }),
    ]);
    expect(listed.text).toContain("team Desk");
    const all = await call("bots_list", { include_archived: true });
    expect(Listed.parse(all.data).bots.map((bot) => bot.id)).toEqual(["bot-ada", "bot-old"]);

    const got = await call("bots_get", { bot: "ada" });
    expect(got.isError).toBe(false);
    expect(got.data.bot).toMatchObject({ id: "bot-ada", soul: "Answer with numbers.", cwd: "/tmp/ada" });
    expect(got.data.team).toBe("Desk");
    expect(got.data.systemPrompt).toEqual(expect.stringContaining("Answer with numbers."));
    expect(got.text).toContain("System prompt:");
    expect((await call("bots_get", { bot: "Nobody" })).isError).toBe(true);
  });

  it("creates bots from a role, a preset or blank, starting from the defaults", async () => {
    const preset: Preset = {
      id: "pr-1",
      name: "Clerk",
      title: "Files things",
      description: "",
      avatar: { seed: "clerk-face", palette: 3, shape: "square", imageUrl: null },
      soul: "File it.",
      playbooks: [],
      skillIds: [],
      createdAt: NOW,
    };
    const defaults = {
      provider: "codex",
      model: "gpt",
      modeId: null,
      thinkingOptionId: null,
      contactBots: "off" as const,
    };
    const { call, store } = await control({ presets: [preset], defaults });

    const scout = await call("bots_create", { role: "research", description: "Digs." });
    expect(scout.data).toMatchObject({ status: "applied", bot: { name: "Scout", title: "Researcher" } });
    const blank = await call("bots_create", {});
    const second = await call("bots_create", { title: "Another" });
    const clerk = await call("bots_create", { preset: "clerk", name: "Clara" });
    expect((await call("bots_create", { preset: "clerk", role: "ops" })).isError).toBe(true);

    const bots = (await store.read()).values.bots;
    const byId = (result: typeof scout) => bots.find((bot) => bot.id === SavedBot.parse(result.data).bot.id);
    expect(byId(scout)).toMatchObject({
      description: "Digs.",
      provider: "codex",
      model: "gpt",
      contactBots: "off",
    });
    expect(byId(scout)?.soul).not.toBe("");
    expect([byId(blank)?.name, byId(second)?.name]).toEqual(["New bot", "New bot 2"]);
    expect(byId(clerk)).toMatchObject({
      name: "Clara",
      soul: "File it.",
      avatar: preset.avatar,
      provider: "codex",
    });
    expect(bots).toHaveLength(6);
  });
});

describe("updating bots", () => {
  useTempPaseoHome("paseo-bots-control-bots-update-");

  it("updates a bot's fields, and archiving needs confirm", async () => {
    const { call, store } = await control();
    const updated = await call("bots_update", {
      bot: "Ada",
      name: "Adele",
      instructions: "Be brief.",
      contact_bots: "allow",
      add_playbooks: [{ name: "Report", triggers: ["report"], instructions: "Write it up." }],
      allow_tools: ["linear/list_issues"],
      disallow_tools: ["github/search"],
    });
    expect(updated.data).toMatchObject({ status: "applied", bot: { name: "Adele" } });
    const saved = defined((await store.read()).values.bots.find((bot) => bot.id === "bot-ada"));
    expect(saved).toMatchObject({
      soul: "Be brief.",
      contactBots: "allow",
      alwaysAllow: ["linear/list_issues"],
    });
    expect(saved.playbooks.map((playbook) => playbook.name)).toEqual(["Report"]);
    expect((await store.read()).values.history.map((entry) => entry.snapshot.name)).toEqual(["Ada"]);

    expect((await call("bots_update", { bot: "Adele", archived: true })).isError).toBe(true);
    await call("bots_update", { bot: "Adele", archived: true, confirm: true });
    expect((await store.read()).values.bots.find((bot) => bot.id === "bot-ada")?.archived).toBe(true);
  });

  it("holds a mode that runs without asking for approval, unless elevated changes are allowed", async () => {
    const { call, store, toggles } = await control();
    const pending = await call("bots_update", { bot: "Ada", mode: "bypassPermissions" });
    expect(pending.data).toMatchObject({ status: "pending" });
    expect(pending.text).toContain("Waiting for approval");
    expect((await store.read()).values.bots[0]?.modeId).toBeNull();
    const proposal = defined(await getProposal(Pending.parse(pending.data).proposal));
    expect(proposal).toMatchObject({ kind: "changes", origin: "control", status: "pending" });

    const created = await call("bots_create", { name: "Runner", mode: "bypassPermissions" });
    expect(created.data.status).toBe("pending");
    expect((await store.read()).values.bots).toHaveLength(2);

    toggles.allowElevated = true;
    expect((await call("bots_update", { bot: "Ada", mode: "bypassPermissions" })).data.status).toBe(
      "applied",
    );
    expect((await store.read()).values.bots[0]?.modeId).toBe("bypassPermissions");
  });
});

describe("duplicating and deleting bots", () => {
  useTempPaseoHome("paseo-bots-control-bots-copy-");

  it("duplicates a bot as the Duplicate menu item does", async () => {
    const { call, store } = await control();
    const copied = await call("bots_duplicate", { bot: "Ada" });
    expect(copied.data).toMatchObject({ status: "applied", bot: { name: "Ada copy" } });
    const copy = defined((await store.read()).values.bots.find((bot) => bot.name === "Ada copy"));
    expect(copy.id).not.toBe(ada.id);
    expect(copy).toMatchObject({
      soul: ada.soul,
      title: ada.title,
      skillIds: ada.skillIds,
      alwaysAllow: ada.alwaysAllow,
      cwd: ada.cwd,
      pinned: false,
    });
    expect(copy.avatar.seed).not.toBe(ada.avatar.seed);
  });

  it("holds a copy that runs without asking in an import proposal", async () => {
    const free = { ...ada, modeId: "bypassPermissions" };
    const { call, store, context, toggles } = await control({ bots: [free] });
    const pending = await call("bots_duplicate", { bot: "Ada" });
    expect(pending.data.status).toBe("pending");
    expect((await store.read()).values.bots).toHaveLength(1);
    const proposal = defined(await getProposal(Pending.parse(pending.data).proposal));
    expect(proposal.kind).toBe("import");
    expect(proposal.data).toMatchObject({
      bots: [{ bot: { name: "Ada copy", modeId: "bypassPermissions" }, skills: [], mcpServers: [] }],
      teams: [],
    });
    await acceptProposal(proposal.id, { store, commands: context.commands });
    expect((await store.read()).values.bots.map((bot) => bot.name)).toEqual(["Ada", "Ada copy"]);

    toggles.allowElevated = true;
    expect((await call("bots_duplicate", { bot: "bot-ada" })).data.status).toBe("applied");
    expect((await store.read()).values.bots).toHaveLength(3);
  });

  it("deletes a bot only with confirm", async () => {
    const { call, store } = await control();
    const refused = await call("bots_delete", { bot: "Ada" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("Invalid arguments");
    expect((await store.read()).values.bots).toHaveLength(2);
    const deleted = await call("bots_delete", { bot: "Ada", confirm: true });
    expect(deleted.data).toMatchObject({ status: "applied", bot: { id: "bot-ada" } });
    const values = (await store.read()).values;
    expect(values.bots.map((bot) => bot.id)).toEqual(["bot-old"]);
    expect(values.groups?.[0]?.leadId).toBeNull();
  });
});

describe("bot history, defaults, presets and pictures", () => {
  useTempPaseoHome("paseo-bots-control-bots-history-");

  it("lists a bot's earlier versions and restores one, keeping the current one", async () => {
    const earlier = { ...ada, title: "Intern", soul: "Ask first." };
    const { call, store } = await control({
      history: [{ botId: "bot-ada", at: EARLIER, snapshot: earlier }],
    });
    const history = await call("bots_history", { bot: "Ada" });
    expect(history.data.versions).toEqual([{ at: EARLIER, snapshot: earlier }]);
    expect(history.text).toContain("Intern");
    expect((await call("bots_restore", { bot: "Ada", at: "2020-01-01T00:00:00.000Z" })).isError).toBe(true);

    const restored = await call("bots_restore", { bot: "Ada", at: EARLIER });
    expect(restored.data.status).toBe("applied");
    const values = (await store.read()).values;
    expect(values.bots[0]).toMatchObject({ title: "Intern", soul: "Ask first." });
    expect(values.history.map((entry) => entry.snapshot.title)).toEqual(["Intern", "Analyst"]);
  });

  it("restores an elevated version's other settings and holds its mode for approval", async () => {
    const earlier = { ...ada, title: "Runner", modeId: "bypassPermissions" };
    const { call, store, context } = await control({
      history: [{ botId: "bot-ada", at: EARLIER, snapshot: earlier }],
    });
    const restored = await call("bots_restore", { bot: "Ada", at: EARLIER });
    expect(restored.data).toMatchObject({ status: "pending", bot: "bot-ada" });
    expect((await store.read()).values.bots[0]).toMatchObject({ title: "Runner", modeId: null });
    const proposal = defined(await getProposal(Pending.parse(restored.data).proposal));
    expect(proposal.kind).toBe("changes");
    await acceptProposal(proposal.id, { store, commands: context.commands });
    expect((await store.read()).values.bots[0]).toMatchObject({
      title: "Runner",
      modeId: "bypassPermissions",
    });
  });

  it("reads and sets the new-bot defaults, holding an unattended mode for approval", async () => {
    const { call, store } = await control();
    expect((await call("defaults_get")).data.defaults).toMatchObject({ provider: "", contactBots: "ask" });
    const set = await call("defaults_set", { provider: "codex", model: "gpt", contact_bots: "off" });
    expect(set.data).toMatchObject({ status: "applied", defaults: { provider: "codex", model: "gpt" } });
    expect((await store.read()).values.defaults).toMatchObject({ provider: "codex", contactBots: "off" });
    expect((await call("defaults_set", { mode: "bypassPermissions" })).data.status).toBe("pending");
    expect((await store.read()).values.defaults?.modeId).toBeNull();
  });

  it("saves, lists and deletes presets, deleting only with confirm", async () => {
    const { call, store } = await control();
    const saved = await call("presets_save", { bot: "Ada" });
    expect(saved.data).toMatchObject({ status: "applied", preset: { name: "Ada", skills: ["triage"] } });
    const listed = await call("presets_list");
    expect(listed.data.presets).toEqual([expect.objectContaining({ name: "Ada", title: "Analyst" })]);
    expect((await call("presets_delete", { preset: "Ada" })).isError).toBe(true);
    const deleted = await call("presets_delete", { preset: "Ada", confirm: true });
    expect(deleted.data.deleted).toEqual([SavedPreset.parse(saved.data).preset.id]);
    expect((await store.read()).values.presets).toEqual([]);
  });

  it("asks for an OpenAI key in the app before drawing a picture", async () => {
    const { call, store } = await control();
    const drawn = await call("avatars_generate", { bot: "Ada" });
    expect(drawn.isError).toBe(true);
    expect(drawn.text).toContain("Add it in the app");
    expect((await call("avatars_generate", {})).isError).toBe(true);
    expect((await store.read()).values.bots[0]?.avatar.imageUrl).toBeNull();
  });
});
