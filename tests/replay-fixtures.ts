import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pluginDataPath } from "../server/bot-home";
import { type AcceptServices, createProposal, listProposals } from "../server/proposals";
import { BotStore } from "../server/state";
import type { Change } from "../shared/changes/schema";
import { makeBot } from "./helpers";

export const commands = { add: async () => ({ id: "", command: "", cwd: "" }) };

/** A store with one bot, Ada, of its own so tests never share state. */
export async function seeded(): Promise<BotStore> {
  const store = new BotStore(join(pluginDataPath(), `state-${Math.random().toString(36).slice(2)}.json`));
  await store.update((values) => ({ ...values, bots: [makeBot({ id: "bot-a", name: "Ada" })] }));
  return store;
}

/** A store that dies right after the changes and their receipt reached disk. */
export function dyingAfterCommit(store: BotStore): AcceptServices["store"] {
  return {
    read: () => store.read(),
    apply: async (operation, run) => {
      await store.apply(operation, run);
      throw new Error("crash after the config write");
    },
  };
}

/** A store that dies before the changes are written. */
export function dyingBeforeCommit(store: BotStore): AcceptServices["store"] {
  return {
    read: () => store.read(),
    apply: async () => {
      throw new Error("crash before the config write");
    },
  };
}

/** Every kind of thing a change can make with an id or a seed of its own. */
export const SETUP: Change[] = [
  {
    type: "create_bot",
    name: "Nova",
    avatar: { new_face: true },
    playbooks: [{ name: "Triage", triggers: ["mail"], instructions: "Sort it" }],
  },
  { type: "create_team", name: "Crew", members: ["Nova", "Ada"], logo: { new_logo: true } },
  { type: "add_mcp_server", name: "files", command: "node", args: ["server.js"] },
  {
    type: "add_routine",
    bot: "Ada",
    name: "Daily",
    instructions: "Check mail",
    schedule: { type: "interval", every_minutes: 60 },
  },
  { type: "save_preset", bot: "Ada" },
];

export const changesProposal = () =>
  createProposal({
    botId: "",
    agentId: "",
    origin: "control",
    kind: "changes",
    data: { summary: "Set up", changes: SETUP, provider: "claude" },
  });

export const importProposal = () =>
  createProposal({
    botId: "",
    agentId: "",
    origin: "control",
    kind: "import",
    data: {
      summary: "One bot",
      bots: [
        {
          bot: makeBot({ id: "bot-imp", name: "Imp" }),
          skills: [],
          mcpServers: [
            { name: "tools", enabled: false, config: { type: "stdio", command: "x", args: [], env: {} } },
          ],
        },
      ],
      teams: [{ name: "Imports", logo: null, lead: 0, members: [0], instructions: "" }],
    },
  });

export const routineProposal = () =>
  createProposal({
    botId: "bot-a",
    agentId: "chat",
    kind: "routine",
    data: {
      name: "Nightly",
      prompt: "Look",
      schedule: { kind: "interval", minutes: 30 },
      resultsChatId: null,
    },
  });

export const SKILL_TEXT = "---\nname: Triage\ndescription: Sorts mail\n---\nSort it.\n";

export const skillProposal = (name = "triage") =>
  createProposal({
    botId: "bot-a",
    agentId: "chat",
    kind: "skill",
    data: { name, description: "Sorts mail", text: SKILL_TEXT },
  });

export function stagedIds(): Promise<string[]> {
  return readdir(join(pluginDataPath(), "staging", "skills")).catch(() => []);
}

export async function pendingIds(): Promise<string[]> {
  return (await listProposals({ status: "pending" })).map((proposal) => proposal.id);
}
