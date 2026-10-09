import { afterEach, describe, expect, it } from "vitest";
import { PROPOSAL_TOOLS } from "../server/control/tools/proposals";
import { createProposal, getProposal } from "../server/proposals";
import { startControl } from "./control-helpers";
import { makeBot, useTempPaseoHome } from "./helpers";

const running: { stop(): Promise<void> }[] = [];

/** The allowlist is one file for the whole suite, so tests that add rules use their own bot id. */
async function control(settings: { allowElevated?: boolean } = {}, id = "bot-a") {
  const started = await startControl(PROPOSAL_TOOLS, { bots: [makeBot({ id, name: "Ada" })] }, settings);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

function bypassProposal() {
  return createProposal({
    botId: "",
    agentId: "",
    origin: "control",
    kind: "changes",
    data: {
      summary: "Let Ada run free",
      changes: [{ type: "update_bot", bot: "bot-a", mode: "bypassPermissions" }],
      provider: "",
    },
  });
}

function commandProposal() {
  return createProposal({
    botId: "bot-a",
    agentId: "",
    origin: "control",
    kind: "command",
    data: { command: "npm test", cwd: "/tmp" },
  });
}

describe("proposal tools", () => {
  useTempPaseoHome("paseo-bots-control-proposals-");

  it("lists, fetches and accepts a chat's skill and routine proposals", async () => {
    const { call, store } = await control();
    const skill = await createProposal({
      botId: "bot-a",
      agentId: "chat-1",
      kind: "skill",
      data: { name: "triage", description: "Sorts mail", text: "---\nname: triage\n---\nSort it." },
    });
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

    const listed = await call("proposals_list", { origin: "chat" });
    const ids = (listed.data.proposals as { id: string }[]).map((entry) => entry.id);
    expect(ids).toEqual(expect.arrayContaining([skill.id, routine.id]));
    expect(listed.text).toContain(skill.id);
    expect(listed.text).toContain("Sorts mail");
    expect((await call("proposals_list", { origin: "control" })).data.proposals).not.toContainEqual(
      expect.objectContaining({ id: skill.id }),
    );

    const fetched = await call("proposals_get", { id: routine.id });
    expect(fetched.data).toMatchObject({ id: routine.id, kind: "routine", bot: "Ada", elevations: [] });
    expect(fetched.data.data).toMatchObject({ name: "Daily", prompt: "Check mail" });

    expect((await call("proposals_accept", { id: skill.id })).data).toMatchObject({
      proposal: { status: "accepted" },
      skill: { id: "triage" },
    });
    expect((await call("proposals_accept", { id: routine.id })).isError).toBe(false);
    const { values } = await store.read();
    expect(values.library?.skills.find((entry) => entry.id === "triage")?.enabled).toBe(true);
    expect(values.bots[0]?.skillIds).toContain("triage");
    expect(values.bots[0]?.routines.map((entry) => entry.name)).toEqual(["Daily"]);
    expect((await call("proposals_list", {})).data.proposals).not.toContainEqual(
      expect.objectContaining({ id: routine.id }),
    );
    expect((await call("proposals_list", { status: "accepted" })).data.proposals).toContainEqual(
      expect.objectContaining({ id: routine.id }),
    );
    expect((await call("proposals_accept", { id: routine.id })).isError).toBe(true);
  });

  it("dismisses a proposal without applying it", async () => {
    const { call, store } = await control();
    const proposal = await bypassProposal();
    const dismissed = await call("proposals_dismiss", { id: proposal.id });
    expect(dismissed.data).toMatchObject({ proposal: { id: proposal.id, status: "dismissed" } });
    expect((await getProposal(proposal.id))?.status).toBe("dismissed");
    expect((await store.read()).values.bots[0]?.modeId).toBeNull();
    expect((await call("proposals_accept", { id: proposal.id })).isError).toBe(true);
  });
});

describe("elevated and secret proposal content", () => {
  useTempPaseoHome("paseo-bots-control-elevated-");

  it("refuses elevated proposals until elevated changes are allowed", async () => {
    const { call, store, context, toggles } = await control();
    const bypass = await bypassProposal();
    const command = await commandProposal();
    expect((await call("proposals_get", { id: bypass.id })).data.elevations).toHaveLength(1);

    for (const proposal of [bypass, command]) {
      const refused = await call("proposals_accept", { id: proposal.id });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("Accept it under");
      expect((await getProposal(proposal.id))?.status).toBe("pending");
    }
    expect((await store.read()).values.bots[0]?.modeId).toBeNull();
    expect(await context.commands.list("bot-a")).toEqual([]);

    toggles.allowElevated = true;
    for (const proposal of [bypass, command])
      expect((await call("proposals_accept", { id: proposal.id })).isError).toBe(false);
    expect((await store.read()).values.bots[0]?.modeId).toBe("bypassPermissions");
    expect(await context.commands.list("bot-a")).toContainEqual(
      expect.objectContaining({ command: "npm test", cwd: "/tmp" }),
    );
  });

  it("hides MCP env and header values in a proposal", async () => {
    const { call } = await control();
    const proposal = await createProposal({
      botId: "",
      agentId: "",
      origin: "control",
      kind: "changes",
      data: {
        summary: "Add a server",
        changes: [{ type: "add_mcp_server", name: "mail", command: "mail-mcp", env: { TOKEN: "sk-secret" } }],
        provider: "",
      },
    });
    const fetched = await call("proposals_get", { id: proposal.id });
    expect(JSON.stringify(fetched.data)).not.toContain("sk-secret");
    expect(fetched.data.data).toMatchObject({ changes: [{ env: { TOKEN: "•••" } }] });
  });
});

describe("command allowlist tools", () => {
  useTempPaseoHome("paseo-bots-control-commands-");

  it("proposes an allowed command, which adds the rule once accepted", async () => {
    const { call, context, toggles } = await control({}, "bot-p");
    const pending = await call("commands_allow", { bot: "Ada", command: "make build", cwd: "/srv/app" });
    expect(pending.data.status).toBe("pending");
    expect(await context.commands.list("bot-p")).toEqual([]);
    const id = String(pending.data.proposal);
    expect(await getProposal(id)).toMatchObject({
      kind: "command",
      origin: "control",
      botId: "bot-p",
      data: { command: "make build", cwd: "/srv/app" },
    });
    expect((await call("proposals_accept", { id })).isError).toBe(true);

    toggles.allowElevated = true;
    expect((await call("proposals_accept", { id })).isError).toBe(false);
    expect((await call("commands_list", { bot: "Ada" })).data.rules).toEqual([
      expect.objectContaining({ command: "make build", cwd: "/srv/app" }),
    ]);
    expect((await call("commands_allow", { bot: "Ada", command: "ls", cwd: "relative" })).isError).toBe(true);
  });

  it("allows, lists and removes commands directly when elevated changes are allowed", async () => {
    const { call } = await control({ allowElevated: true }, "bot-d");
    const allowed = await call("commands_allow", { bot: "bot-d", command: "npm run lint", cwd: "/repo" });
    expect(allowed.data.status).toBe("applied");
    const rule = allowed.data.rule as { id: string };
    const listed = await call("commands_list", { bot: "Ada" });
    expect(listed.data.rules).toEqual([{ id: rule.id, command: "npm run lint", cwd: "/repo" }]);
    expect(listed.text).toContain("npm run lint");

    expect((await call("commands_remove", { bot: "Ada", id: rule.id })).isError).toBe(true);
    expect((await call("commands_list", { bot: "Ada" })).data.rules).toHaveLength(1);
    expect((await call("commands_remove", { bot: "Ada", id: rule.id, confirm: true })).isError).toBe(false);
    expect((await call("commands_list", { bot: "Ada" })).data.rules).toEqual([]);
    expect((await call("commands_remove", { bot: "Ada", id: rule.id, confirm: true })).isError).toBe(true);
  });
});
