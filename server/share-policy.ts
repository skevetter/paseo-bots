import type { Bot } from "../shared/bot";
import {
  type Policy,
  type PolicyBody,
  PolicyBodySchema,
  type PolicyState,
  type ResolvedRole,
  resolveBot,
  usesPolicy,
} from "../shared/policies";
import { hashBody } from "./operations";

function portableRole(role: ResolvedRole) {
  return role.enabled.value
    ? {
        ...(role.provider.value === null ? {} : { provider: role.provider.value }),
        model: role.model.value,
        thinkingOptionId: role.thinkingOptionId.value,
        requirements: role.requirements.value,
      }
    : null;
}

/** Source bindings are host-local; a snapshot preserves their effective limits without importing their authority. */
export function portableRuntimePolicy(values: PolicyState, bot: Bot): PolicyBody | undefined {
  if (!usesPolicy(values, bot) && !bot.policy?.inherit.length) return undefined;
  const resolution = resolveBot(values, bot);
  const missing = resolution.issues.filter(
    (issue) => issue.code === "unknown_policy" || issue.code === "unknown_revision",
  );
  if (missing.length) throw new Error(missing.map((issue) => issue.message).join(" "));
  return PolicyBodySchema.parse({
    name: `${bot.name} runtime snapshot`.slice(0, 100),
    purpose: "Portable snapshot of effective execution settings; approval is chosen on the destination host.",
    ...(resolution.taskClasses.value === null ? {} : { taskClasses: resolution.taskClasses.value }),
    roles: {
      executor: {
        ...(resolution.provider.value === null ? {} : { provider: resolution.provider.value }),
        model: resolution.model.value,
        thinkingOptionId: resolution.thinkingOptionId.value,
        requirements: resolution.requirements.value,
      },
      planner: portableRole(resolution.roles.planner),
      advisor: portableRole(resolution.roles.advisor),
      verifier: portableRole(resolution.roles.verifier),
      reviewer: portableRole(resolution.roles.reviewer),
    },
    routing: resolution.routing.value,
    budget: {
      maxRunSeconds: resolution.budget.maxRunSeconds.value,
      maxRunCostUsd: resolution.budget.maxRunCostUsd.value,
      maxRunTokens: resolution.budget.maxRunTokens.value,
    },
    concurrency: { maxConcurrentRuns: resolution.concurrency.maxConcurrentRuns.value },
  });
}

/** Equal snapshots share a content-derived identity, never a name or an id from the exporting host. */
export function importedRuntimePolicy(body: PolicyBody, at: string): Policy {
  return { ...body, id: `pol-${hashBody(body).slice(0, 48)}`, revision: 1, createdAt: at };
}
