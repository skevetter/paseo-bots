import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Proposal } from "../shared/proposals";
import { pluginDataPath } from "./bot-home";
import { readParsed, writeJson } from "./files";
import { writeSkill } from "./library";

const KEEP = 200;

type NewProposal = Pick<Proposal, "botId" | "agentId" | "kind" | "data">;

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

/** One read-modify-write at a time. */
function update<T>(change: (proposals: Proposal[]) => { proposals: Proposal[]; result: T }): Promise<T> {
  const run = async () => {
    const { proposals, result } = change(await load());
    await writeJson(storePath(), { proposals: proposals.slice(-KEEP) });
    return result;
  };
  const next = queue.then(run);
  queue = next.catch(() => {});
  return next;
}

export function createProposal(input: NewProposal): Promise<Proposal> {
  const proposal = {
    ...input,
    id: `p-${randomBytes(5).toString("hex")}`,
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  } as Proposal;
  return update((proposals) => ({ proposals: [...proposals, proposal], result: proposal }));
}

export async function getProposal(id: string): Promise<Proposal | null> {
  return (await load()).find((proposal) => proposal.id === id) ?? null;
}

function resolve(id: string, status: "accepted" | "dismissed"): Promise<Proposal> {
  return update((proposals) => {
    const current = proposals.find((proposal) => proposal.id === id);
    if (!current) throw new Error("This proposal is no longer available.");
    if (current.status !== "pending")
      throw new Error(current.status === "accepted" ? "It's already saved." : "It was dismissed.");
    const resolved = { ...current, status, resolvedAt: new Date().toISOString() };
    return {
      proposals: proposals.map((proposal) => (proposal.id === id ? resolved : proposal)),
      result: resolved,
    };
  });
}

export function dismissProposal(id: string): Promise<Proposal> {
  return resolve(id, "dismissed");
}

/** Saves on this host only; the app then records it in the bots' settings. */
export async function acceptProposal(id: string) {
  const proposal = await getProposal(id);
  if (!proposal) throw new Error("This proposal is no longer available.");
  if (proposal.status !== "pending")
    throw new Error(proposal.status === "accepted" ? "It's already saved." : "It was dismissed.");
  if (proposal.kind !== "skill") return { proposal: await resolve(id, "accepted") };
  const saved = await writeSkill({ id: proposal.data.name, text: proposal.data.text });
  const accepted = await resolve(id, "accepted");
  return {
    proposal: accepted,
    skill: { id: proposal.data.name, description: saved.description, sha: saved.sha },
  };
}
