import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { newRoutineId } from "../shared/bot-ids";
import { applyChanges } from "../shared/changes/apply";
import { addImportedBots, setBotUses, updateSkill, upsertSkills } from "../shared/library";
import type { Proposal } from "../shared/proposals";
import { pluginDataPath } from "./bot-home";
import type { CommandAllowlist } from "./commands";
import { readParsed, writeJson } from "./files";
import { writeSkill } from "./library";
import type { BotStore } from "./state";

const KEEP = 200;

type NewProposal = Pick<Proposal, "botId" | "agentId" | "kind" | "data"> & Partial<Pick<Proposal, "origin">>;

export interface AcceptServices {
  store: Pick<BotStore, "read" | "update">;
  commands: Pick<CommandAllowlist, "add">;
  /** Runs on the state being written and throws to refuse. */
  guard?: (proposal: Proposal, values: BotState) => void;
}

export interface AcceptedSkill {
  id: string;
  description: string;
  sha: string;
}

function storePath(): string {
  return join(pluginDataPath(), "proposals.json");
}

function parseProposals(text: string): Proposal[] {
  const saved: unknown = JSON.parse(text);
  if (typeof saved !== "object" || saved === null) throw new Error("proposals.json isn't an object");
  if (!("proposals" in saved)) return [];
  if (!Array.isArray(saved.proposals)) throw new Error("proposals.json has no list of proposals");
  return saved.proposals;
}

async function load(): Promise<Proposal[]> {
  return (await readParsed(storePath(), parseProposals)) ?? [];
}

let queue: Promise<unknown> = Promise.resolve();

function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch(() => {});
  return next;
}

async function save(proposals: Proposal[]): Promise<void> {
  await writeJson(storePath(), { proposals: proposals.slice(-KEEP) }, 0o600);
}

export function createProposal(input: NewProposal): Promise<Proposal> {
  const proposal = {
    origin: "chat",
    ...input,
    id: `p-${randomBytes(5).toString("hex")}`,
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  } as Proposal;
  return serial(async () => {
    await save([...(await load()), proposal]);
    return proposal;
  });
}

export async function getProposal(id: string): Promise<Proposal | null> {
  return (await load()).find((proposal) => proposal.id === id) ?? null;
}

/** Newest first. */
export async function listProposals(
  filter: Partial<Pick<Proposal, "status" | "origin">>,
): Promise<Proposal[]> {
  return (await load())
    .filter((proposal) => !filter.status || proposal.status === filter.status)
    .filter((proposal) => !filter.origin || (proposal.origin ?? "chat") === filter.origin)
    .reverse();
}

function pending(proposals: readonly Proposal[], id: string): Proposal {
  const current = proposals.find((proposal) => proposal.id === id);
  if (!current) throw new Error("This proposal is no longer available.");
  if (current.status !== "pending")
    throw new Error(current.status === "accepted" ? "It's already saved." : "It was dismissed.");
  return current;
}

async function resolve(id: string, status: "accepted" | "dismissed"): Promise<Proposal> {
  const proposals = await load();
  const resolved = { ...pending(proposals, id), status, resolvedAt: new Date().toISOString() };
  await save(proposals.map((proposal) => (proposal.id === id ? resolved : proposal)));
  return resolved;
}

export function dismissProposal(id: string): Promise<Proposal> {
  return serial(() => resolve(id, "dismissed"));
}

function withRoutine(values: BotState, proposal: Extract<Proposal, { kind: "routine" }>): BotState {
  const routine = {
    id: newRoutineId(),
    ...proposal.data,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  return {
    ...values,
    bots: values.bots.map((bot) =>
      bot.id === proposal.botId ? { ...bot, routines: [...bot.routines, routine] } : bot,
    ),
  };
}

function withSkill(values: BotState, botId: string, skill: AcceptedSkill): BotState {
  const library = upsertSkills(values.library ?? EMPTY_LIBRARY, [
    { id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha },
  ]);
  return {
    ...values,
    library: updateSkill(library, skill.id, { enabled: true }),
    bots: values.bots.map((bot) => (bot.id === botId ? setBotUses(bot, "skill", skill.id, true) : bot)),
  };
}

async function apply(proposal: Proposal, services: AcceptServices): Promise<AcceptedSkill | null> {
  const { store, commands, guard = () => {} } = services;
  const checked = (change: (values: BotState) => BotState) =>
    store.update((values) => {
      guard(proposal, values);
      return change(values);
    });
  switch (proposal.kind) {
    case "skill": {
      guard(proposal, (await store.read()).values);
      const saved = await writeSkill({ id: proposal.data.name, text: proposal.data.text });
      const skill = { id: proposal.data.name, ...saved };
      await checked((values) => withSkill(values, proposal.botId, skill));
      return skill;
    }
    case "routine":
      await checked((values) => withRoutine(values, proposal));
      return null;
    case "changes": {
      const context = { now: new Date().toISOString(), provider: proposal.data.provider };
      await checked((values) => applyChanges(values, proposal.data.changes, context));
      return null;
    }
    case "command":
      guard(proposal, (await store.read()).values);
      await commands.add(proposal.botId, proposal.data.command, proposal.data.cwd);
      return null;
    case "import":
      await checked((values) => addImportedBots(values, proposal.data.bots, proposal.data.teams));
      return null;
  }
}

/** Applied before it counts as accepted, so a change that no longer fits leaves it pending. */
export function acceptProposal(
  id: string,
  services: AcceptServices,
): Promise<{ proposal: Proposal; skill?: AcceptedSkill }> {
  return serial(async () => {
    const skill = await apply(pending(await load(), id), services);
    return { proposal: await resolve(id, "accepted"), ...(skill ? { skill } : {}) };
  });
}
