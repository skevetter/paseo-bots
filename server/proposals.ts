import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { applyChanges } from "../shared/changes/apply";
import type { ProviderInfo } from "../shared/changes/context";
import { changeIds } from "../shared/changes/ids";
import { findReceipt, type Operation, type OperationScope } from "../shared/changes/operation";
import type { ApplicationReceipt } from "../shared/changes/receipt";
import { addImportedBots, setBotUses, updateSkill, upsertSkills } from "../shared/library";
import type { Proposal } from "../shared/proposals";
import { pluginDataPath } from "./bot-home";
import type { CommandAllowlist } from "./commands";
import { readParsed, writeJson } from "./files";
import { discardStagedSkills, publishStagedSkill, stageSkill } from "./library";
import { newOperation } from "./operations";
import type { BotStore } from "./state";

const KEEP = 200;

type NewProposal = Pick<Proposal, "botId" | "agentId" | "kind" | "data"> & Partial<Pick<Proposal, "origin">>;

export interface AcceptServices {
  store: Pick<BotStore, "read" | "apply">;
  commands: Pick<CommandAllowlist, "add">;
  /** The host's providers, which pick new bots' approval modes. */
  providers?: readonly ProviderInfo[] | null;
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

function withRoutine(
  values: BotState,
  proposal: Extract<Proposal, { kind: "routine" }>,
  scope: OperationScope,
): BotState {
  const routine = {
    id: changeIds(scope.operationId, 0).id("rt"),
    ...proposal.data,
    enabled: true,
    createdAt: scope.now,
  };
  return {
    ...values,
    bots: values.bots.map((bot) =>
      bot.id === proposal.botId ? { ...bot, routines: [...bot.routines, routine] } : bot,
    ),
  };
}

function withSkill(values: BotState, botId: string, skill: AcceptedSkill, now: string): BotState {
  const library = upsertSkills(
    values.library ?? EMPTY_LIBRARY,
    [{ id: skill.id, description: skill.description, source: "", reviewedSha: skill.sha }],
    now,
  );
  return {
    ...values,
    library: updateSkill(library, skill.id, { enabled: true }),
    bots: values.bots.map((bot) => (bot.id === botId ? setBotUses(bot, "skill", skill.id, true) : bot)),
  };
}

/** The proposal's id names its operation, so accepting it again is the same operation. */
function operationFor(proposal: Proposal): Operation {
  return newOperation({
    id: proposal.id,
    kind: proposal.kind,
    body: { kind: proposal.kind, botId: proposal.botId, data: proposal.data },
  });
}

interface Applied {
  skill: AcceptedSkill | null;
  receipt: ApplicationReceipt | null;
}

async function apply(proposal: Proposal, services: AcceptServices): Promise<Applied> {
  const { store, commands, providers, guard = () => {} } = services;
  const operation = operationFor(proposal);
  const run = (change: (values: BotState, scope: OperationScope) => { values: BotState; notes?: string[] }) =>
    store.apply(operation, (values, scope) => {
      guard(proposal, values);
      return change(values, scope);
    });
  switch (proposal.kind) {
    case "skill": {
      guard(proposal, (await store.read()).values);
      const { name, text } = proposal.data;
      const skill = { id: name, ...(await stageSkill(operation.id, text)) };
      // A refusal or a crash leaves the staged file for the next attempt or the recovery to clear.
      const { receipt } = await run((values, scope) => ({
        values: withSkill(values, proposal.botId, skill, scope.now),
      }));
      await publishStagedSkill(operation.id, name, text);
      return { skill, receipt };
    }
    case "routine":
      return {
        skill: null,
        receipt: (await run((values, scope) => ({ values: withRoutine(values, proposal, scope) }))).receipt,
      };
    case "changes": {
      const { changes, provider } = proposal.data;
      const { receipt } = await run((values, scope) => {
        const notes: string[] = [];
        const context = { now: scope.now, operationId: scope.operationId, provider, providers, notes };
        return { values: applyChanges(values, changes, context), notes };
      });
      return { skill: null, receipt };
    }
    case "command":
      // The allowlist takes an exact command once, so accepting again changes nothing.
      guard(proposal, (await store.read()).values);
      await commands.add(proposal.botId, proposal.data.command, proposal.data.cwd);
      return { skill: null, receipt: null };
    case "import": {
      const { bots, teams } = proposal.data;
      const { receipt } = await run((values, scope) => ({
        values: addImportedBots(values, bots, teams, {
          now: scope.now,
          ids: changeIds(scope.operationId, 0),
        }),
      }));
      return { skill: null, receipt };
    }
  }
}

/**
 * The changes and their receipt are saved in one write, then the proposal is marked accepted. A crash
 * between them leaves the proposal pending with its receipt in the state, so accepting again, or the
 * recovery at startup, only marks it: the changes are never applied twice. A change that no longer fits
 * leaves it pending.
 */
export function acceptProposal(
  id: string,
  services: AcceptServices,
): Promise<{ proposal: Proposal; skill?: AcceptedSkill; receipt?: ApplicationReceipt }> {
  return serial(async () => {
    const { skill, receipt } = await apply(pending(await load(), id), services);
    return {
      proposal: await resolve(id, "accepted"),
      ...(skill ? { skill } : {}),
      ...(receipt ? { receipt } : {}),
    };
  });
}

export interface Recovery {
  /** Proposals whose changes were saved but which were still pending, now accepted. */
  accepted: string[];
  /** Pending proposals whose operation id was saved with other content; accepting them reports it. */
  conflicts: string[];
  /** Skill files staged by an operation that never saved its changes. */
  discarded: string[];
}

/** A pending proposal whose changes were saved only needs its file published and its mark. */
async function finish(proposal: Proposal, values: BotState, recovery: Recovery): Promise<void> {
  const receipt = proposal.status === "pending" ? findReceipt(values, proposal.id) : undefined;
  if (!receipt) return;
  if (receipt.bodyHash !== operationFor(proposal).bodyHash) {
    recovery.conflicts.push(proposal.id);
    return;
  }
  if (proposal.kind === "skill")
    await publishStagedSkill(proposal.id, proposal.data.name, proposal.data.text);
  await resolve(proposal.id, "accepted");
  recovery.accepted.push(proposal.id);
}

/** Run at startup, before anything accepts a proposal. Finishes what a crash left half done. */
export function recoverProposals(store: Pick<BotStore, "read">): Promise<Recovery> {
  return serial(async () => {
    const { values } = await store.read();
    const recovery: Recovery = { accepted: [], conflicts: [], discarded: [] };
    for (const proposal of await load()) await finish(proposal, values, recovery);
    // Nothing else is accepting a proposal now, so what is still staged never saved its changes.
    recovery.discarded = await discardStagedSkills(() => false);
    return recovery;
  });
}
