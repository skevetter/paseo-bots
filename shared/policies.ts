import { z } from "zod";
import type { Bot, BotState, Routine } from "./bot";
import { defaultModelId } from "./bot-agent";
import { supportsToolGrants } from "./bot-tools";
import type { ProviderInfo } from "./changes/context";
import { teamOf } from "./groups";
import { CapabilityNameSchema, TaskClassSchema } from "./task-contract";

// Shared runtime policies. A policy is a named, versioned bundle of execution settings (which model runs a
// role, what it may cost, how many run at once). Policies never carry permissions: the approval mode stays
// a bot's own, and a routine may only narrow it.
//
// Settings resolve layer by layer, lowest first: global, the bot's team, the bot's own policy, the bot's
// explicit overrides, the routine's overrides. A field a layer leaves out is inherited. `null` is only
// accepted where the schema gives it a meaning: model and thinking level (the provider's default), a
// budget limit (no limit) and a delegated role (not delegated).
// Nothing here reads or writes anything, so the same state resolves the same way wherever it runs.

export const POLICY_ID = /^pol-[a-z0-9]{1,60}$/;
export const PolicyIdSchema = z.string().regex(POLICY_ID);

const Provider = z.string().min(1).max(100);
const ModelId = z.string().min(1).max(200);
const ThinkingId = z.string().min(1).max(100);

/** What runs an agent; a model or thinking level only means something for its provider. */
const SelectorFields = {
  provider: Provider.optional(),
  model: ModelId.nullable().optional(),
  thinkingOptionId: ThinkingId.nullable().optional(),
};

/** The capability must be known to be supported; an unknown one does not qualify. */
export const CapabilityRequirementSchema = z.strictObject({ capability: CapabilityNameSchema });
export type CapabilityRequirement = z.infer<typeof CapabilityRequirementSchema>;

export const RoleSelectorSchema = z.strictObject({
  ...SelectorFields,
  requirements: z.array(CapabilityRequirementSchema).max(20).optional(),
});
export type RoleSelector = z.infer<typeof RoleSelectorSchema>;

export const ROLES = ["executor", "planner", "advisor", "verifier", "reviewer"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = z.infer<typeof RoleSchema>;
const DELEGATED_ROLES = ["planner", "advisor", "verifier", "reviewer"] as const;
type DelegatedRole = (typeof DELEGATED_ROLES)[number];

/** Which selector a kind of task goes to. Only the schema lives here; routing itself comes later. */
export const RoutingRuleSchema = z.strictObject({
  id: TaskClassSchema,
  taskClasses: z.array(TaskClassSchema).min(1).max(50),
  role: RoleSchema.default("executor"),
  select: RoleSelectorSchema,
});
export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

/** Per run. `null` is no limit. */
export const BudgetSchema = z.strictObject({
  maxRunSeconds: z.number().int().positive().nullable().optional(),
  maxRunCostUsd: z.number().positive().nullable().optional(),
  maxRunTokens: z.number().int().positive().nullable().optional(),
});
export type Budget = z.infer<typeof BudgetSchema>;
const BUDGET_FIELDS = ["maxRunSeconds", "maxRunCostUsd", "maxRunTokens"] as const;

/** `null` is no limit. */
export const ConcurrencySchema = z.strictObject({
  maxConcurrentRuns: z.number().int().positive().nullable().optional(),
});
export type Concurrency = z.infer<typeof ConcurrencySchema>;

export const PolicyBodySchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  purpose: z.string().max(1000).default(""),
  /** The task classes it allows; left out, it inherits, and with nothing set every class is allowed. */
  taskClasses: z.array(TaskClassSchema).min(1).max(50).optional(),
  roles: z
    .strictObject({
      executor: RoleSelectorSchema.optional(),
      planner: RoleSelectorSchema.nullable().optional(),
      advisor: RoleSelectorSchema.nullable().optional(),
      verifier: RoleSelectorSchema.nullable().optional(),
      reviewer: RoleSelectorSchema.nullable().optional(),
    })
    .default({}),
  routing: z.array(RoutingRuleSchema).max(50).optional(),
  budget: BudgetSchema.default({}),
  concurrency: ConcurrencySchema.default({}),
});
export type PolicyBody = z.infer<typeof PolicyBodySchema>;

/** One revision. A revision never changes; saving a policy adds the next one. */
export const PolicySchema = PolicyBodySchema.extend({
  id: PolicyIdSchema,
  revision: z.number().int().min(1),
  createdAt: z.string(),
});
export type Policy = z.infer<typeof PolicySchema>;

/** `revision: null` follows the policy's latest revision; a number stays on that one. */
export const PolicyBindingSchema = z.strictObject({
  policyId: PolicyIdSchema,
  revision: z.number().int().min(1).nullable(),
});
export type PolicyBinding = z.infer<typeof PolicyBindingSchema>;

/**
 * A bot's own provider, model and thinking level are explicit overrides unless listed here, which hands
 * the field to the layers below. A model belongs to its provider and a thinking level to its model, so
 * inheriting the provider means inheriting both, and inheriting the model means inheriting the level.
 */
export const INHERITABLE = ["provider", "model", "thinkingOptionId"] as const;
export type Inheritable = (typeof INHERITABLE)[number];

const GOES_WITH: Record<Inheritable, readonly Inheritable[]> = {
  provider: ["model", "thinkingOptionId"],
  model: ["thinkingOptionId"],
  thinkingOptionId: [],
};

export function closeInheritance(fields: readonly Inheritable[]): Inheritable[] {
  const wanted = new Set(fields.flatMap((field) => [field, ...GOES_WITH[field]]));
  return INHERITABLE.filter((field) => wanted.has(field));
}

export const BotPolicySchema = z
  .strictObject({
    binding: PolicyBindingSchema.nullable().default(null),
    inherit: z.array(z.enum(INHERITABLE)).default([]),
  })
  .superRefine((policy, context) => {
    if (closeInheritance(policy.inherit).length !== new Set(policy.inherit).size)
      context.addIssue({
        code: "custom",
        path: ["inherit"],
        message: "A model goes with its provider and a thinking level with its model; inherit them together.",
      });
  });
export type BotPolicy = z.infer<typeof BotPolicySchema>;

/** Execution fields a routine may override for its own runs. Permissions are a separate field. */
export const RoutineOverridesSchema = z.strictObject({ ...SelectorFields, budget: BudgetSchema.optional() });
export type RoutineOverrides = z.infer<typeof RoutineOverridesSchema>;

// Resolution

export const LAYERS = ["default", "global", "team", "bot_policy", "bot", "routine"] as const;
export const SourceSchema = z.object({
  layer: z.enum(LAYERS),
  policyId: PolicyIdSchema.optional(),
  revision: z.number().int().optional(),
});
export type Source = z.infer<typeof SourceSchema>;

const DEFAULT_SOURCE: Source = { layer: "default" };

function resolved<T extends z.ZodType>(value: T) {
  return z.object({ value, source: SourceSchema });
}
export interface Resolved<T> {
  value: T;
  source: Source;
}

export const ISSUE_CODES = [
  "unknown_policy",
  "unknown_revision",
  "unknown_routine",
  "provider_unresolved",
  "task_class_not_allowed",
  "capability_unsupported",
  "capability_unknown",
  "approval_unverifiable",
  "mode_not_on_provider",
  "approval_changed",
  "permission_broadened",
  "grants_not_preserved",
] as const;
export const IssueSchema = z.object({
  code: z.enum(ISSUE_CODES),
  field: z.string(),
  message: z.string(),
});
export type Issue = z.infer<typeof IssueSchema>;

export const CAPABILITY_STATES = ["supported", "unsupported", "unknown"] as const;
export const CapabilityStateSchema = z.enum(CAPABILITY_STATES);

/** Where a capability claim came from, so a claim can be trusted as far as its source deserves. */
export const ProvenanceSchema = z.object({
  source: z.enum(["provider_snapshot", "probe", "declared", "observed"]),
  observedAt: z.string().nullable(),
  detail: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const CapabilityFactSchema = z.object({ state: CapabilityStateSchema, provenance: ProvenanceSchema });
export type CapabilityFact = z.infer<typeof CapabilityFactSchema>;

/** Provider id to what is known about it, and per model where a model differs. Absent means unknown. */
export type CapabilityFacts = Readonly<
  Record<
    string,
    {
      provider?: Readonly<Record<string, CapabilityFact>>;
      models?: Readonly<Record<string, Readonly<Record<string, CapabilityFact>>>>;
    }
  >
>;

export const CapabilityCheckSchema = z.object({
  capability: z.string(),
  state: CapabilityStateSchema,
  provenance: ProvenanceSchema.nullable(),
  /** Only a capability known to be supported qualifies. */
  qualifies: z.boolean(),
});
export type CapabilityCheck = z.infer<typeof CapabilityCheckSchema>;

const NullableNumber = z.number().nullable();

export const ResolvedRoleSchema = z.object({
  enabled: resolved(z.boolean()),
  provider: resolved(z.string().nullable()),
  model: resolved(z.string().nullable()),
  thinkingOptionId: resolved(z.string().nullable()),
  requirements: resolved(z.array(CapabilityRequirementSchema)),
});
export type ResolvedRole = z.infer<typeof ResolvedRoleSchema>;

export const ResolutionSchema = z.object({
  /** False when the settings can't be used as they are; the fields still show what each layer asked for. */
  ok: z.boolean(),
  issues: z.array(IssueSchema),
  provider: resolved(z.string().nullable()),
  model: resolved(z.string().nullable()),
  thinkingOptionId: resolved(z.string().nullable()),
  requirements: resolved(z.array(CapabilityRequirementSchema)),
  qualification: z.array(CapabilityCheckSchema),
  /** A permission, kept apart: it is the bot's own, and a routine can only narrow it. */
  modeId: resolved(z.string().nullable()),
  roles: z.object({
    planner: ResolvedRoleSchema,
    advisor: ResolvedRoleSchema,
    verifier: ResolvedRoleSchema,
    reviewer: ResolvedRoleSchema,
  }),
  routing: resolved(z.array(RoutingRuleSchema)),
  /** Null is every class. */
  taskClasses: resolved(z.array(TaskClassSchema).nullable()),
  budget: z.object({
    maxRunSeconds: resolved(NullableNumber),
    maxRunCostUsd: resolved(NullableNumber),
    maxRunTokens: resolved(NullableNumber),
  }),
  concurrency: z.object({ maxConcurrentRuns: resolved(NullableNumber) }),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

type Selector = { provider?: string | null; model?: string | null; thinkingOptionId?: string | null };

interface Contribution {
  source: Source;
  selector: Selector;
  requirements?: CapabilityRequirement[];
  taskClasses?: string[];
  routing?: RoutingRule[];
  roles?: Partial<Record<DelegatedRole, RoleSelector | null>>;
  budget?: Budget;
  concurrency?: Concurrency;
}

export interface ResolveInput {
  /** Every revision of every policy. */
  policies: readonly Policy[];
  global: PolicyBinding | null;
  /** The binding of the bot's team. */
  team: PolicyBinding | null;
  bot: Pick<
    Bot,
    "provider" | "model" | "modeId" | "thinkingOptionId" | "policy" | "alwaysAllow" | "contactBots"
  >;
  routine?: Pick<Routine, "overrides" | "modeId"> | null;
  /** The providers on the host that will run the agent; null when not known. */
  providers?: readonly ProviderInfo[] | null;
  capabilities?: CapabilityFacts;
  /** When the work has a class, the policy must allow it. */
  taskClass?: string;
}

/** The newest revision of a policy, or the one a binding pins. */
export function findRevision(policies: readonly Policy[], binding: PolicyBinding): Policy | null {
  let found: Policy | null = null;
  for (const policy of policies) {
    if (policy.id !== binding.policyId) continue;
    if (
      binding.revision === null
        ? policy.revision > (found?.revision ?? 0)
        : policy.revision === binding.revision
    )
      found = policy;
  }
  return found;
}

function contributionOf(policy: Policy, layer: "global" | "team" | "bot_policy"): Contribution {
  const { requirements, ...selector } = policy.roles.executor ?? {};
  const roles: NonNullable<Contribution["roles"]> = {};
  for (const role of DELEGATED_ROLES) if (policy.roles[role] !== undefined) roles[role] = policy.roles[role];
  return {
    source: { layer, policyId: policy.id, revision: policy.revision },
    selector,
    ...(requirements ? { requirements } : {}),
    ...(policy.taskClasses ? { taskClasses: policy.taskClasses } : {}),
    ...(policy.routing ? { routing: policy.routing } : {}),
    roles,
    budget: policy.budget,
    concurrency: policy.concurrency,
  };
}

function bindingContribution(
  input: ResolveInput,
  binding: PolicyBinding | null,
  layer: "global" | "team" | "bot_policy",
): { contribution: Contribution | null; issue: Issue | null } {
  if (!binding) return { contribution: null, issue: null };
  const policy = findRevision(input.policies, binding);
  if (policy) return { contribution: contributionOf(policy, layer), issue: null };
  const known = input.policies.some((entry) => entry.id === binding.policyId);
  return {
    contribution: null,
    issue: {
      code: known ? "unknown_revision" : "unknown_policy",
      field: layer,
      message: known
        ? `Policy ${binding.policyId} has no revision ${binding.revision}.`
        : `Policy ${binding.policyId} no longer exists.`,
    },
  };
}

function botContribution(bot: ResolveInput["bot"]): Contribution {
  const inherited = new Set(bot.policy?.inherit ?? []);
  return {
    source: { layer: "bot" },
    selector: {
      ...(inherited.has("provider") ? {} : { provider: bot.provider }),
      ...(inherited.has("model") ? {} : { model: bot.model }),
      ...(inherited.has("thinkingOptionId") ? {} : { thinkingOptionId: bot.thinkingOptionId }),
    },
  };
}

function routineContribution(routine: NonNullable<ResolveInput["routine"]>): Contribution {
  const { budget, ...selector } = routine.overrides ?? {};
  return { source: { layer: "routine" }, selector, ...(budget ? { budget } : {}) };
}

function contributions(input: ResolveInput): { list: Contribution[]; issues: Issue[] } {
  const bound = [
    bindingContribution(input, input.global, "global"),
    bindingContribution(input, input.team, "team"),
    bindingContribution(input, input.bot.policy?.binding ?? null, "bot_policy"),
  ];
  const list = bound.flatMap((entry) => (entry.contribution ? [entry.contribution] : []));
  list.push(botContribution(input.bot));
  if (input.routine) list.push(routineContribution(input.routine));
  return { list, issues: bound.flatMap((entry) => (entry.issue ? [entry.issue] : [])) };
}

function pick<T>(list: readonly Contribution[], read: (entry: Contribution) => T | undefined, fallback: T) {
  let out: Resolved<T> = { value: fallback, source: DEFAULT_SOURCE };
  for (const entry of list) {
    const value = read(entry);
    if (value !== undefined) out = { value, source: entry.source };
  }
  return out;
}

interface Chosen {
  provider: Resolved<string | null>;
  model: Resolved<string | null>;
  thinkingOptionId: Resolved<string | null>;
}

const SELECTOR_FIELDS = ["provider", "model", "thinkingOptionId"] as const;

/** A layer that switches provider discards selections made for the old one unless it supplies replacements. */
function applySelector(chosen: Chosen, { selector, source }: Contribution): void {
  const switched = selector.provider !== undefined && selector.provider !== chosen.provider.value;
  const layer: Selector = switched
    ? { ...selector, model: selector.model ?? null, thinkingOptionId: selector.thinkingOptionId ?? null }
    : selector;
  for (const field of SELECTOR_FIELDS) {
    const value = layer[field];
    if (value !== undefined) chosen[field] = { value, source };
  }
}

function chooseSelector(list: readonly Contribution[]): Chosen {
  const none = (): Resolved<null> => ({ value: null, source: DEFAULT_SOURCE });
  const chosen: Chosen = { provider: none(), model: none(), thinkingOptionId: none() };
  for (const contribution of list) applySelector(chosen, contribution);
  return chosen;
}

function factFor(
  facts: CapabilityFacts | undefined,
  at: { provider: string; model: string | null },
  capability: string,
): CapabilityFact | null {
  const entry = facts?.[at.provider];
  const byModel = at.model ? entry?.models?.[at.model]?.[capability] : undefined;
  return byModel ?? entry?.provider?.[capability] ?? null;
}

function checkCapabilities(
  input: ResolveInput,
  requirements: readonly CapabilityRequirement[],
  at: { provider: string | null; model: string | null },
): { checks: CapabilityCheck[]; issues: Issue[] } {
  if (requirements.length === 0) return { checks: [], issues: [] };
  const provider = input.providers?.find((entry) => entry.id === at.provider);
  const model = at.model ?? defaultModelId(provider?.models ?? []);
  const checks = requirements.map(({ capability }): CapabilityCheck => {
    const fact = at.provider
      ? factFor(input.capabilities, { provider: at.provider, model }, capability)
      : null;
    return {
      capability,
      state: fact?.state ?? "unknown",
      provenance: fact?.provenance ?? null,
      qualifies: fact?.state === "supported",
    };
  });
  const issues = checks
    .filter((check) => !check.qualifies)
    .map((check): Issue => {
      const unsupported = check.state === "unsupported";
      return {
        code: unsupported ? "capability_unsupported" : "capability_unknown",
        field: "requirements",
        message: unsupported
          ? `${at.provider ?? "The provider"} doesn't support ${check.capability}.`
          : `It isn't known whether ${at.provider ?? "the provider"} supports ${check.capability}, so it doesn't qualify.`,
      };
    });
  return { checks, issues };
}

/** Only a listed mode with an explicit tier is evidence of approval semantics; names alone are not. */
function modeClass(modeId: string | null, provider: ProviderInfo): string | null {
  const id = modeId ?? provider.defaultModeId;
  const tier = provider.modes.find((mode) => mode.id === id)?.colorTier;
  return tier && ["safe", "planning", "moderate", "dangerous"].includes(tier) ? tier : null;
}

function permissionRank(modeId: string | null, provider: ProviderInfo): number | null {
  const tier = modeClass(modeId, provider);
  if (tier === null) return null;
  if (tier === "dangerous") return 2;
  return tier === "moderate" ? 1 : 0;
}

const providerOf = (input: ResolveInput, id: string | null) =>
  id === null ? undefined : input.providers?.find((entry) => entry.id === id);

/** Moving a bot to another provider must preserve the listed approval tier, not just whether it asks. */
function switchIssues(
  bot: Pick<Bot, "provider" | "modeId">,
  to: string,
  providers: readonly ProviderInfo[] | null,
): Issue[] {
  const issue = (code: Issue["code"], message: string): Issue[] => [{ code, field: "modeId", message }];
  const from = providers?.find((entry) => entry.id === bot.provider);
  const target = providers?.find((entry) => entry.id === to);
  if (!from || !target)
    return issue(
      "approval_unverifiable",
      `Moving from ${bot.provider} to ${to} can't be checked against their modes, so the approval mode might change.`,
    );
  if (bot.modeId !== null && !target.modes.some((mode) => mode.id === bot.modeId))
    return issue(
      "mode_not_on_provider",
      `${to} has no mode "${bot.modeId}", the one ${bot.provider} runs in.`,
    );
  const before = modeClass(bot.modeId, from);
  const after = modeClass(bot.modeId, target);
  if (before === null || after === null)
    return issue(
      "approval_unverifiable",
      `The approval semantics of ${bot.provider} and ${to} aren't known.`,
    );
  return before === after
    ? []
    : issue(
        "approval_changed",
        `Moving from ${bot.provider} to ${to} would change the bot's approval semantics.`,
      );
}

/**
 * Validates a provider transition against the effective bot before the change. Bulk preview/apply must
 * pass the before resolution here; resolving an already-edited bot cannot recover its previous approval.
 */
export function validateProviderTransition(
  before: Pick<Bot, "provider" | "modeId" | "alwaysAllow" | "contactBots">,
  targetProvider: string,
  providers: readonly ProviderInfo[] | null,
): Issue[] {
  if (before.provider === targetProvider) return [];
  const issues = switchIssues(before, targetProvider, providers);
  const hasGrants = before.alwaysAllow.length > 0 || before.contactBots === "allow";
  if (hasGrants && !supportsToolGrants(targetProvider))
    issues.push({
      code: "grants_not_preserved",
      field: "provider",
      message: `${targetProvider} cannot preserve this bot's explicit tool approval grants.`,
    });
  return issues;
}

function narrowingIssues(input: ResolveInput, provider: string | null, modeId: string): Issue[] {
  const issue = (code: Issue["code"], message: string): Issue[] => [{ code, field: "modeId", message }];
  const target = providerOf(input, provider);
  if (!target)
    return issue(
      "approval_unverifiable",
      `The mode "${modeId}" can't be compared with the bot's without the provider's modes.`,
    );
  if (!target.modes.some((mode) => mode.id === modeId))
    return issue("mode_not_on_provider", `${target.id} has no mode "${modeId}".`);
  const base = input.bot.modeId ?? target.defaultModeId;
  const before = permissionRank(base, target);
  const after = permissionRank(modeId, target);
  if (before === null || after === null)
    return issue(
      "approval_unverifiable",
      `The approval semantics of the bot's or routine's mode aren't known.`,
    );
  return modeId === base || after < before
    ? []
    : issue(
        "permission_broadened",
        `A routine can only ask more than its bot; "${modeId}" isn't stricter than "${base}".`,
      );
}

function resolveMode(
  input: ResolveInput,
  provider: string | null,
): { mode: Resolved<string | null>; issues: Issue[] } {
  const own: Resolved<string | null> = { value: input.bot.modeId, source: { layer: "bot" } };
  const issues =
    provider === null ? [] : validateProviderTransition(input.bot, provider, input.providers ?? null);
  const narrowed = input.routine?.modeId;
  if (narrowed === undefined || narrowed === input.bot.modeId) return { mode: own, issues };
  return {
    mode: { value: narrowed, source: { layer: "routine" } },
    issues: [...issues, ...narrowingIssues(input, provider, narrowed)],
  };
}

function classIssues(taskClass: string | undefined, allowed: readonly string[] | null): Issue[] {
  if (taskClass === undefined || allowed === null || allowed.includes(taskClass)) return [];
  return [
    {
      code: "task_class_not_allowed",
      field: "taskClasses",
      message: `The policy doesn't allow ${taskClass} work; it allows ${allowed.join(", ")}.`,
    },
  ];
}

/** Each role selector inherits field by field too; explicit null disables it and clears the lower selection. */
function resolveRole(list: readonly Contribution[], name: DelegatedRole): ResolvedRole {
  const roles: Contribution[] = [];
  let enabled: Resolved<boolean> = { value: false, source: DEFAULT_SOURCE };
  for (const entry of list) {
    const role = entry.roles?.[name];
    if (role === undefined) continue;
    enabled = { value: role !== null, source: entry.source };
    roles.push({
      source: entry.source,
      selector: role ?? { provider: null, model: null, thinkingOptionId: null },
      requirements: role === null ? [] : role.requirements,
    });
  }
  return {
    enabled,
    ...chooseSelector(roles),
    requirements: pick<CapabilityRequirement[]>(roles, (role) => role.requirements, []),
  };
}
type Settled = Pick<Resolution, "roles" | "routing" | "budget" | "concurrency">;

/** The fields that only inherit: nothing about them depends on the provider. */
function settle(list: readonly Contribution[]): Settled {
  const budget = (field: (typeof BUDGET_FIELDS)[number]) =>
    pick<number | null>(list, (entry) => entry.budget?.[field], null);
  return {
    roles: {
      planner: resolveRole(list, "planner"),
      advisor: resolveRole(list, "advisor"),
      verifier: resolveRole(list, "verifier"),
      reviewer: resolveRole(list, "reviewer"),
    },
    routing: pick<RoutingRule[]>(list, (entry) => entry.routing, []),
    budget: {
      maxRunSeconds: budget("maxRunSeconds"),
      maxRunCostUsd: budget("maxRunCostUsd"),
      maxRunTokens: budget("maxRunTokens"),
    },
    concurrency: {
      maxConcurrentRuns: pick<number | null>(list, (entry) => entry.concurrency?.maxConcurrentRuns, null),
    },
  };
}

const NO_PROVIDER: Issue = {
  code: "provider_unresolved",
  field: "provider",
  message: "No layer names an agent provider.",
};

/** The settings a bot runs with, each with the layer it came from. Pure. */
export function resolveBotConfig(input: ResolveInput): Resolution {
  const { list, issues } = contributions(input);
  const chosen = chooseSelector(list);
  const requirements = pick<CapabilityRequirement[]>(list, (entry) => entry.requirements, []);
  const qualified = checkCapabilities(input, requirements.value, {
    provider: chosen.provider.value,
    model: chosen.model.value,
  });
  const { mode, issues: modeIssues } = resolveMode(input, chosen.provider.value);
  const taskClasses = pick<string[] | null>(list, (entry) => entry.taskClasses, null);
  const all = [
    ...issues,
    ...(chosen.provider.value === null ? [NO_PROVIDER] : []),
    ...qualified.issues,
    ...modeIssues,
    ...classIssues(input.taskClass, taskClasses.value),
  ];
  return {
    ok: all.length === 0,
    issues: all,
    ...chosen,
    requirements,
    qualification: qualified.checks,
    modeId: mode,
    taskClasses,
    ...settle(list),
  };
}

export type PolicyState = Pick<BotState, "policies" | "globalPolicy" | "groups">;

export interface ResolveOptions {
  routineId?: string | undefined;
  taskClass?: string | undefined;
  providers?: readonly ProviderInfo[] | null | undefined;
  capabilities?: CapabilityFacts | undefined;
}

/** Gathers the layers a bot's settings come from: the global and team bindings, the bot and one of its routines. */
export function resolveBot(values: PolicyState, bot: Bot, options: ResolveOptions = {}): Resolution {
  const routine = options.routineId
    ? bot.routines.find((entry) => entry.id === options.routineId)
    : undefined;
  const resolution = resolveBotConfig({
    policies: values.policies ?? [],
    global: values.globalPolicy ?? null,
    team: teamOf(bot.id, values.groups ?? [])?.policy ?? null,
    bot,
    routine: routine ?? null,
    providers: options.providers ?? null,
    capabilities: options.capabilities,
    taskClass: options.taskClass,
  });
  const issues: Issue[] = [...resolution.issues];
  if (options.routineId && !routine)
    issues.push({
      code: "unknown_routine",
      field: "routineId",
      message: `No routine ${options.routineId} on ${bot.name}.`,
    });
  return { ...resolution, ok: issues.length === 0, issues };
}

/** Whether any policy layer or routine override can change what the bot's own settings say. */
export function usesPolicy(values: PolicyState, bot: Bot, routineId?: string): boolean {
  const routine = routineId ? bot.routines.find((entry) => entry.id === routineId) : undefined;
  return (
    !!values.globalPolicy ||
    !!teamOf(bot.id, values.groups ?? [])?.policy ||
    !!bot.policy?.binding ||
    !!routine?.overrides ||
    routine?.modeId !== undefined
  );
}

export interface LaunchSettings {
  provider: string;
  /** Null is the provider's default model. */
  model: string | null;
  modeId: string | null;
  thinkingOptionId: string | null;
}

export class PolicyResolutionError extends Error {
  constructor(readonly issues: readonly Issue[]) {
    super(issues.map((issue) => issue.message).join(" "));
    this.name = "PolicyResolutionError";
  }
}

/** What an agent starts with; refuses settings that cannot be used as they are. */
export function launchSettings(resolution: Resolution): LaunchSettings {
  const { provider } = resolution;
  if (!resolution.ok || provider.value === null) throw new PolicyResolutionError(resolution.issues);
  return {
    provider: provider.value,
    model: resolution.model.value,
    modeId: resolution.modeId.value,
    thinkingOptionId: resolution.thinkingOptionId.value,
  };
}

// Revisions and references

/** The newest revision of each policy, in the order the policies were first saved. */
export function currentPolicies(policies: readonly Policy[]): Policy[] {
  const newest = new Map<string, Policy>();
  for (const policy of policies) {
    const held = newest.get(policy.id);
    if (!held || policy.revision > held.revision) newest.set(policy.id, policy);
  }
  return [...newest.values()];
}

export function nextRevision(policies: readonly Policy[], id: string): number {
  return Math.max(0, ...policies.filter((policy) => policy.id === id).map((policy) => policy.revision)) + 1;
}

export type Referrer =
  | { kind: "global" }
  | { kind: "team"; id: string; name: string }
  | { kind: "bot"; id: string; name: string };

export const ReferrerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("team"), id: z.string(), name: z.string() }),
  z.object({ kind: z.literal("bot"), id: z.string(), name: z.string() }),
]);

/** Everything bound to a policy, whatever revision it follows or pins. */
export function policyReferrers(values: PolicyState & Pick<BotState, "bots">, policyId: string): Referrer[] {
  return [
    ...(values.globalPolicy?.policyId === policyId ? [{ kind: "global" as const }] : []),
    ...(values.groups ?? [])
      .filter((group) => group.policy?.policyId === policyId)
      .map((group) => ({ kind: "team" as const, id: group.id, name: group.name })),
    ...values.bots
      .filter((bot) => bot.policy?.binding?.policyId === policyId)
      .map((bot) => ({ kind: "bot" as const, id: bot.id, name: bot.name })),
  ];
}

/** Hands the named fields back to the layers below: the explicit clear-to-inherit operation. */
export function unsetOverrides(bot: Bot, fields: readonly Inheritable[]): Bot {
  const inherit = closeInheritance([...(bot.policy?.inherit ?? []), ...fields]);
  return { ...bot, policy: { binding: bot.policy?.binding ?? null, inherit } };
}

// Capability facts

/** What Paseo's provider snapshot says outright: thinking levels per model and approval modes per provider. */
export function snapshotCapabilities(
  providers: readonly ProviderInfo[],
  observedAt: string | null,
): CapabilityFacts {
  const fact = (supported: boolean): CapabilityFact => ({
    state: supported ? "supported" : "unknown",
    provenance: { source: "provider_snapshot", observedAt },
  });
  return Object.fromEntries(
    providers.map((provider) => [
      provider.id,
      {
        provider: {
          approval_modes: fact(provider.modes.length > 0),
        },
        models: Object.fromEntries(
          provider.models.map((model) => [model.id, { thinking_levels: fact(model.thinking.length > 0) }]),
        ),
      },
    ]),
  );
}

/** An explicit settings edit takes ownership again; a supplied policy patch is already an explicit inheritance decision. */
export function patchBotOverrides(bot: Bot, patch: Partial<Bot>): Bot {
  const next = { ...bot, ...patch };
  if (!bot.policy || patch.policy !== undefined) return next;
  const own: Record<Inheritable, boolean> = {
    provider:
      patch.provider !== undefined || patch.model !== undefined || patch.thinkingOptionId !== undefined,
    model: patch.model !== undefined || patch.thinkingOptionId !== undefined,
    thinkingOptionId: patch.thinkingOptionId !== undefined,
  };
  const inherit = bot.policy.inherit.filter((field) => !own[field]);
  return { ...next, policy: { ...bot.policy, inherit } };
}
