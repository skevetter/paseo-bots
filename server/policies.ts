import type { BotState, StateSnapshot } from "../shared/bot";
import { findBot } from "../shared/changes/refs";
import {
  currentPolicies,
  findRevision,
  nextRevision,
  type Policy,
  type PolicyBody,
  PolicyBodySchema,
  policyReferrers,
  type Referrer,
  type Resolution,
  resolveBot,
  snapshotCapabilities,
} from "../shared/policies";
import { prefixedId } from "../shared/uuid";
import { hostProviders } from "./apply-context";
import type { BotsHost } from "./host";
import type { BotStore } from "./state";

export async function listPolicies(store: Pick<BotStore, "read">) {
  const { revision, values } = await store.read();
  return { revision, policies: currentPolicies(values.policies ?? []) };
}

export async function getPolicy(store: Pick<BotStore, "read">, input: { id: string; revision?: number }) {
  const { policies = [] } = (await store.read()).values;
  return {
    policy: findRevision(policies, { policyId: input.id, revision: input.revision ?? null }),
    revisions: policies.filter((policy) => policy.id === input.id).map((policy) => policy.revision),
  };
}

/** Every successful save appends a new immutable revision. */
function withRevision(
  policies: readonly Policy[],
  save: { id: string | undefined; body: PolicyBody; now: string },
): { policies: readonly Policy[]; policy: Policy } {
  const body = PolicyBodySchema.parse(save.body);
  const newest = save.id ? findRevision(policies, { policyId: save.id, revision: null }) : null;
  if (save.id && !newest) throw new Error(`There is no policy ${save.id}.`);
  const id = save.id ?? prefixedId("pol");
  const policy: Policy = {
    ...body,
    id,
    revision: nextRevision(policies, id),
    createdAt: save.now,
  };
  return { policies: [...policies, policy], policy };
}

export type SaveResult =
  | { status: "saved"; revision: string; policy: Policy }
  | { status: "conflict"; error: string };

/** Adds a revision over the state `revision` the caller read; a revision that exists is never changed. */
export async function savePolicy(
  store: Pick<BotStore, "edit">,
  input: { revision: string; id?: string | undefined; policy: PolicyBody },
  now: string = new Date().toISOString(),
): Promise<SaveResult> {
  const made: { policy?: Policy } = {};
  const result = await store.edit(input.revision, (values) => {
    const next = withRevision(values.policies ?? [], { id: input.id, body: input.policy, now });
    made.policy = next.policy;
    return { ...values, policies: [...next.policies] };
  });
  if (result.status === "conflict") return result;
  if (!made.policy) throw new Error("A saved policy has no revision.");
  return { status: "saved", revision: result.revision, policy: made.policy };
}

class InUse extends Error {
  constructor(readonly referrers: Referrer[]) {
    super("The policy is still in use.");
  }
}

export type DeleteResult =
  | { status: "deleted"; revision: string }
  | { status: "conflict"; error: string }
  | { status: "referenced"; referrers: Referrer[] };

function withoutPolicy(values: BotState, id: string): BotState {
  const { policies = [], ...rest } = values;
  const kept = policies.filter((policy) => policy.id !== id);
  if (kept.length === policies.length) throw new Error(`There is no policy ${id}.`);
  return kept.length > 0 ? { ...rest, policies: kept } : rest;
}

/** Removes every revision of a policy nothing is bound to; otherwise says who still uses it. */
export async function deletePolicy(
  store: Pick<BotStore, "edit">,
  input: { revision: string; id: string },
): Promise<DeleteResult> {
  try {
    const result = await store.edit(input.revision, (values) => {
      const referrers = policyReferrers(values, input.id);
      if (referrers.length > 0) throw new InUse(referrers);
      return withoutPolicy(values, input.id);
    });
    return result.status === "conflict" ? result : { status: "deleted", revision: result.revision };
  } catch (error) {
    if (error instanceof InUse) return { status: "referenced", referrers: error.referrers };
    throw error;
  }
}

/** What a bot, or one of its routines, runs with on this host, checked against the providers it knows. */
export async function resolveForBot(
  host: BotsHost,
  input: { bot: string; routineId?: string | undefined; taskClass?: string | undefined },
): Promise<{ snapshot: StateSnapshot; resolution: Resolution }> {
  const snapshot = await host.store.read();
  const bot = findBot(snapshot.values, input.bot);
  const { providers } = await hostProviders(host);
  const resolution = resolveBot(snapshot.values, bot, {
    routineId: input.routineId,
    taskClass: input.taskClass,
    providers,
    capabilities: providers ? snapshotCapabilities(providers, new Date().toISOString()) : undefined,
  });
  return { snapshot, resolution };
}
