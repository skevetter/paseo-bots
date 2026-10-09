import { describe, expect, it } from "vitest";
import { acceptProposal, createProposal, dismissProposal, listProposals } from "../server/proposals";
import { BotStore } from "../server/state";
import { makeBot, useTempPaseoHome } from "./helpers";

describe("accepting proposals on the host", () => {
  useTempPaseoHome("paseo-bots-proposals-");

  async function services() {
    const store = new BotStore();
    await store.update((values) => ({ ...values, bots: [makeBot({ id: "bot-a", name: "Ada" })] }));
    const added: string[] = [];
    const commands = {
      add: async (botId: string, command: string, cwd: string) => {
        added.push(`${botId}:${command}@${cwd}`);
        return { id: "r", command, cwd };
      },
    };
    return { store, commands, added };
  }

  it("applies routine, setup, command and import proposals", async () => {
    const { store, commands, added } = await services();
    const routine = await createProposal({
      botId: "bot-a",
      agentId: "chat-1",
      kind: "routine",
      data: {
        name: "Daily",
        prompt: "Check mail",
        schedule: { kind: "interval", minutes: 60 },
        resultsChatId: null,
      },
    });
    const changes = await createProposal({
      botId: "",
      agentId: "",
      origin: "control",
      kind: "changes",
      data: {
        summary: "Rename",
        changes: [{ type: "update_bot", bot: "Ada", title: "Inbox lead" }],
        provider: "",
      },
    });
    const command = await createProposal({
      botId: "bot-a",
      agentId: "",
      origin: "control",
      kind: "command",
      data: { command: "npm test", cwd: "/tmp" },
    });
    const imported = await createProposal({
      botId: "",
      agentId: "",
      origin: "control",
      kind: "import",
      data: {
        summary: "One bot",
        bots: [{ bot: makeBot({ id: "bot-b", name: "Ada" }), skills: [], mcpServers: [] }],
        teams: [{ name: "Crew", logo: null, lead: 0, members: [0], instructions: "" }],
      },
    });
    for (const proposal of [routine, changes, command, imported])
      expect((await acceptProposal(proposal.id, { store, commands })).proposal.status).toBe("accepted");

    const { values } = await store.read();
    expect(values.bots.map((bot) => bot.name)).toEqual(["Ada", "Ada 2"]);
    expect(values.bots[0]?.routines.map((entry) => [entry.name, entry.enabled])).toEqual([["Daily", true]]);
    expect(values.bots[0]?.title).toBe("Inbox lead");
    expect(values.groups?.map((group) => [group.name, group.memberIds])).toEqual([["Crew", ["bot-b"]]]);
    expect(added).toEqual(["bot-a:npm test@/tmp"]);
  });

  it("leaves a proposal pending when its change no longer fits", async () => {
    const { store, commands } = await services();
    const stale = await createProposal({
      botId: "",
      agentId: "",
      origin: "control",
      kind: "changes",
      data: { summary: "Gone", changes: [{ type: "delete_bot", bot: "Nobody" }], provider: "" },
    });
    await expect(acceptProposal(stale.id, { store, commands })).rejects.toThrow("Nobody");
    const pending = await listProposals({ status: "pending", origin: "control" });
    expect(pending.map((proposal) => proposal.id)).toContain(stale.id);
    expect((await dismissProposal(stale.id)).status).toBe("dismissed");
    expect((await listProposals({ status: "pending" })).map((proposal) => proposal.id)).not.toContain(
      stale.id,
    );
  });
});
