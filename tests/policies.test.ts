import { describe, expect, it } from "vitest";
import { type BotGroup, BotSchema } from "../shared/bot";
import { providerInfo } from "../shared/changes/context";
import {
  type CapabilityFacts,
  closeInheritance,
  type Policy,
  type PolicyBinding,
  type PolicyBody,
  PolicySchema,
  patchBotOverrides,
  policyReferrers,
  type Resolution,
  type ResolveInput,
  resolveBot,
  resolveBotConfig,
  snapshotCapabilities,
  unsetOverrides,
  validateProviderTransition,
} from "../shared/policies";
import { makeBot, NOW } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

const providers = providerInfo(LIVE_PROVIDERS);

function policy(id: string, revision: number, body: Partial<PolicyBody> = {}): Policy {
  return PolicySchema.parse({ id, revision, createdAt: NOW, name: id, ...body });
}

const follow = (policyId: string): PolicyBinding => ({ policyId, revision: null });

function resolve(patch: Partial<ResolveInput> = {}) {
  return resolveBotConfig({
    policies: [],
    global: null,
    team: null,
    bot: makeBot(),
    providers,
    ...patch,
  });
}

describe("a bot with no policy", () => {
  it.each([
    { provider: "claude", model: null, modeId: null, thinkingOptionId: null },
    { provider: "omp", model: "pi", modeId: "full", thinkingOptionId: "high" },
    { provider: "claude", model: "opus", modeId: "bypassPermissions", thinkingOptionId: null },
    { provider: "unlisted", model: "x", modeId: "whatever", thinkingOptionId: "y" },
  ])("resolves to exactly its own settings: %j", (own) => {
    const resolution = resolveBot({}, makeBot(own), { providers });
    expect(resolution.ok).toBe(true);
    expect([
      resolution.provider.value,
      resolution.model.value,
      resolution.modeId.value,
      resolution.thinkingOptionId.value,
    ]).toEqual([own.provider, own.model, own.modeId, own.thinkingOptionId]);
    expect(resolution.provider.source).toEqual({ layer: "bot" });
  });

  it("needs no provider list to resolve", () => {
    expect(resolveBot({}, makeBot({ provider: "claude" })).ok).toBe(true);
  });
});

const policies = [
  policy("pol-global", 1, {
    roles: { executor: { provider: "omp", model: "pi", thinkingOptionId: "low" } },
    budget: { maxRunSeconds: 600, maxRunCostUsd: 2 },
    concurrency: { maxConcurrentRuns: 4 },
    taskClasses: ["invoice.send", "report.write"],
  }),
  policy("pol-team", 1, { budget: { maxRunSeconds: 300 }, concurrency: { maxConcurrentRuns: null } }),
  policy("pol-bot", 1, { roles: { executor: { model: "pi2" }, reviewer: { provider: "claude" } } }),
];
const inheriting = makeBot({
  policy: { binding: follow("pol-bot"), inherit: ["provider", "model", "thinkingOptionId"] },
});

describe("layers", () => {
  it("takes each field from the highest layer that sets it, and says which", () => {
    const resolution = resolve({
      policies,
      global: follow("pol-global"),
      team: follow("pol-team"),
      bot: inheriting,
    });
    expect(resolution.provider).toEqual({
      value: "omp",
      source: { layer: "global", policyId: "pol-global", revision: 1 },
    });
    expect(resolution.model).toEqual({
      value: "pi2",
      source: { layer: "bot_policy", policyId: "pol-bot", revision: 1 },
    });
    // The level was chosen below, for the model the bot policy replaced, and nothing above overrides it.
    expect(resolution.thinkingOptionId.value).toBe("low");
    expect(resolution.budget.maxRunSeconds).toEqual({
      value: 300,
      source: { layer: "team", policyId: "pol-team", revision: 1 },
    });
    expect(resolution.budget.maxRunCostUsd.source.layer).toBe("global");
    expect(resolution.budget.maxRunTokens).toEqual({ value: null, source: { layer: "default" } });
    expect(resolution.roles.reviewer.provider.value).toBe("claude");
    expect(resolution.roles.planner.enabled.source.layer).toBe("default");
  });

  it("lets null mean what the schema says, and a missing field inherit", () => {
    const resolution = resolve({ policies, global: follow("pol-global"), team: follow("pol-team") });
    // The team set the limit to null, which is "no limit"; it did not leave it out.
    expect(resolution.concurrency.maxConcurrentRuns).toEqual({
      value: null,
      source: { layer: "team", policyId: "pol-team", revision: 1 },
    });
    expect(resolution.budget.maxRunCostUsd.value).toBe(2);
  });

  it("keeps a bot's own settings over every policy until it hands them back", () => {
    const own = makeBot({ provider: "claude", model: "opus", thinkingOptionId: "max" });
    const asOwn = resolve({ policies, global: follow("pol-global"), bot: own });
    expect([asOwn.provider.value, asOwn.model.value, asOwn.thinkingOptionId.value]).toEqual([
      "claude",
      "opus",
      "max",
    ]);
    expect(asOwn.provider.source).toEqual({ layer: "bot" });

    const handedBack = resolve({
      policies,
      global: follow("pol-global"),
      bot: unsetOverrides(own, ["provider"]),
    });
    expect(handedBack.provider.value).toBe("omp");
    expect(handedBack.model.value).toBe("pi");
    expect(handedBack.thinkingOptionId.value).toBe("low");
  });

  it("hands back only the thinking level when that is all that is cleared", () => {
    const own = makeBot({ provider: "omp", model: "pi", thinkingOptionId: "max", modeId: "ask" });
    const resolution = resolve({
      policies,
      global: follow("pol-global"),
      bot: unsetOverrides(own, ["thinkingOptionId"]),
    });
    expect(resolution.model).toEqual({ value: "pi", source: { layer: "bot" } });
    expect(resolution.thinkingOptionId.value).toBe("low");
  });

  it("drops a model and level chosen for one provider when a higher layer moves to another", () => {
    const moves = policy("pol-moves", 1, { roles: { executor: { provider: "claude" } } });
    const resolution = resolve({
      policies: [...policies, moves],
      global: follow("pol-global"),
      team: follow("pol-moves"),
      bot: unsetOverrides(makeBot(), ["provider"]),
    });
    expect(resolution.provider.value).toBe("claude");
    expect(resolution.model).toEqual({
      value: null,
      source: { layer: "team", policyId: "pol-moves", revision: 1 },
    });
    expect(resolution.thinkingOptionId.value).toBeNull();
  });

  it("applies a routine's overrides last, for its execution fields only", () => {
    const resolution = resolve({
      policies,
      global: follow("pol-global"),
      bot: unsetOverrides(makeBot(), ["provider"]),
      routine: { overrides: { model: "pi3", budget: { maxRunSeconds: 60 } } },
    });
    expect(resolution.model).toEqual({ value: "pi3", source: { layer: "routine" } });
    expect(resolution.provider.source.layer).toBe("global");
    expect(resolution.budget.maxRunSeconds).toEqual({ value: 60, source: { layer: "routine" } });
    expect(resolution.budget.maxRunCostUsd.value).toBe(2);
  });
});

describe("bindings", () => {
  it("follows the newest revision unless a binding pins one, and says which it used", () => {
    const revised = [
      policy("pol-a", 1, { budget: { maxRunSeconds: 10 } }),
      policy("pol-a", 2, { budget: { maxRunSeconds: 20 } }),
    ];
    expect(resolve({ policies: revised, global: follow("pol-a") }).budget.maxRunSeconds.source.revision).toBe(
      2,
    );
    const pinned = resolve({ policies: revised, global: { policyId: "pol-a", revision: 1 } });
    expect(pinned.budget.maxRunSeconds).toEqual({
      value: 10,
      source: { layer: "global", policyId: "pol-a", revision: 1 },
    });
  });

  it("refuses to use a binding whose policy or revision is gone, instead of skipping the layer", () => {
    const gone = resolve({ global: follow("pol-missing") });
    expect(gone.ok).toBe(false);
    expect(gone.issues.map((issue) => issue.code)).toEqual(["unknown_policy"]);
    const lost = resolve({ policies: [policy("pol-a", 1)], team: { policyId: "pol-a", revision: 7 } });
    expect(lost.issues.map((issue) => issue.code)).toEqual(["unknown_revision"]);
  });

  it("flags a provider no layer names", () => {
    const resolution = resolve({ bot: unsetOverrides(makeBot(), ["provider"]) });
    expect(resolution.ok).toBe(false);
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["provider_unresolved"]);
  });

  it("allows only the task classes the policy names", () => {
    const input = { policies, global: follow("pol-global") };
    expect(resolve({ ...input, taskClass: "invoice.send" }).ok).toBe(true);
    expect(resolve({ ...input, taskClass: "email.send" }).issues.map((issue) => issue.code)).toEqual([
      "task_class_not_allowed",
    ]);
    expect(resolve({ taskClass: "anything" }).ok).toBe(true);
  });

  it("finds the bot's team in the state", () => {
    const team: BotGroup = {
      id: "t1",
      name: "Ops",
      logo: null,
      leadId: null,
      memberIds: ["bot-1"],
      instructions: "",
      createdAt: NOW,
      updatedAt: NOW,
      policy: follow("pol-global"),
    };
    const resolution = resolveBot({ policies, groups: [team] }, unsetOverrides(makeBot(), ["provider"]), {
      providers,
    });
    expect(resolution.provider.source).toEqual({ layer: "team", policyId: "pol-global", revision: 1 });
  });
});

describe("capability requirements", () => {
  const needs = (...capabilities: string[]) =>
    policy("pol-needs", 1, {
      roles: {
        executor: { provider: "omp", requirements: capabilities.map((capability) => ({ capability })) },
      },
    });
  const own = unsetOverrides(makeBot({ provider: "omp", modeId: "full" }), ["provider"]);
  const facts = snapshotCapabilities(providers, NOW);

  it("qualifies only what is known to be supported, and keeps where the claim came from", () => {
    const resolution = resolve({
      policies: [needs("approval_modes")],
      global: follow("pol-needs"),
      bot: own,
      capabilities: facts,
    });
    expect(resolution.ok).toBe(true);
    expect(resolution.qualification).toEqual([
      {
        capability: "approval_modes",
        state: "supported",
        provenance: { source: "provider_snapshot", observedAt: NOW },
        qualifies: true,
      },
    ]);
  });

  it("does not let an unknown capability qualify, and tells it from an unsupported one", () => {
    const resolution = resolve({
      policies: [needs("vision", "thinking_levels")],
      global: follow("pol-needs"),
      bot: own,
      capabilities: facts,
    });
    const byCapability = Object.fromEntries(
      resolution.qualification.map((check) => [check.capability, check]),
    );
    expect(byCapability.vision).toMatchObject({ state: "unknown", provenance: null, qualifies: false });
    expect(resolution.issues.map((issue) => issue.code)).toContain("capability_unknown");

    const none: CapabilityFacts = {
      omp: {
        provider: { vision: { state: "unsupported", provenance: { source: "declared", observedAt: null } } },
      },
    };
    const unsupported = resolve({
      policies: [needs("vision")],
      global: follow("pol-needs"),
      bot: own,
      capabilities: none,
    });
    expect(unsupported.issues.map((issue) => issue.code)).toEqual(["capability_unsupported"]);
  });

  it("is unknown, so not qualified, when no facts were given at all", () => {
    expect(resolve({ policies: [needs("vision")], global: follow("pol-needs"), bot: own }).ok).toBe(false);
  });

  it.each([null, "pi"])(
    "checks model-specific facts for the selected model %s, including provider default",
    (model) => {
      const claim = (state: "supported" | "unsupported") => ({
        state,
        provenance: { source: "probe" as const, observedAt: NOW },
      });
      const mixed: CapabilityFacts = {
        omp: { provider: { vision: claim("supported") }, models: { pi: { vision: claim("unsupported") } } },
      };
      const withModel = policy("pol-model", 1, {
        roles: { executor: { provider: "omp", model, requirements: [{ capability: "vision" }] } },
      });
      const resolution = resolve({
        policies: [withModel],
        global: follow("pol-model"),
        bot: own,
        capabilities: mixed,
      });
      expect(resolution.issues.map((issue) => issue.code)).toEqual(["capability_unsupported"]);
    },
  );
});

describe("approval stays the bot's own", () => {
  const moves = (provider: string) => policy("pol-moves", 1, { roles: { executor: { provider } } });
  const hostedBy = (provider: string, bot = makeBot()) =>
    resolve({
      policies: [moves(provider)],
      global: follow("pol-moves"),
      bot: unsetOverrides(bot, ["provider"]),
    });

  it("allows a move that leaves the bot asking, and keeps its mode", () => {
    const resolution = hostedBy("omp", makeBot({ provider: "claude", modeId: "default" }));
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["mode_not_on_provider"]);
    // "ask" is omp's strict mode; the bot's mode id isn't one of omp's, so it is refused, not translated.
    expect(resolution.modeId).toEqual({ value: "default", source: { layer: "bot" } });
  });

  it("refuses a move when mode names exist but approval evidence is missing", () => {
    const moved = hostedBy("hermes", makeBot({ provider: "claude", modeId: "default" }));
    expect(moved.issues.map((issue) => issue.code)).toEqual(["approval_unverifiable"]);
  });

  it("refuses a move that would turn an asking bot into one that runs freely", () => {
    // Claude's default mode asks; omp's default mode is "full access".
    const resolution = hostedBy("omp", makeBot({ provider: "claude", modeId: null }));
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["approval_changed"]);
  });

  it("refuses the opposite move too, so approval never changes either way", () => {
    const resolution = hostedBy("claude", makeBot({ provider: "omp", modeId: null }));
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["approval_changed"]);
  });

  it("cannot vouch for a move without the providers' modes", () => {
    const resolution = resolveBotConfig({
      policies: [moves("omp")],
      global: follow("pol-moves"),
      team: null,
      bot: unsetOverrides(makeBot(), ["provider"]),
    });
    expect(resolution.issues.map((issue) => issue.code)).toEqual(["approval_unverifiable"]);
  });

  it("does not check approval when the provider stays put", () => {
    expect(resolve({ bot: makeBot({ provider: "omp", modeId: "full" }) }).ok).toBe(true);
  });
});

describe("a routine may narrow permissions, never broaden them", () => {
  const bot = (modeId: string | null) => makeBot({ provider: "claude", modeId });
  const narrowed = (base: string | null, to: string) => resolve({ bot: bot(base), routine: { modeId: to } });
  const codes = (resolution: Resolution) => resolution.issues.map((issue) => issue.code);

  it("accepts a mode that asks where the bot runs without asking", () => {
    const resolution = narrowed("bypassPermissions", "default");
    expect(resolution.ok).toBe(true);
    expect(resolution.modeId).toEqual({ value: "default", source: { layer: "routine" } });
  });

  it("accepts a safe mode under one that asks only for some things", () => {
    expect(narrowed("acceptEdits", "default").ok).toBe(true);
  });

  it("compares with the provider's default when the bot has no mode of its own", () => {
    // Claude starts in "auto" here, which asks; "bypassPermissions" would not.
    expect(codes(narrowed(null, "bypassPermissions"))).toEqual(["permission_broadened"]);
    expect(narrowed(null, "default").ok).toBe(true);
  });

  it("refuses a mode that runs without asking over one that asks", () => {
    expect(codes(narrowed("default", "bypassPermissions"))).toEqual(["permission_broadened"]);
  });

  it("refuses a different mode it cannot show to be stricter", () => {
    expect(codes(narrowed("acceptEdits", "auto"))).toEqual(["permission_broadened"]);
  });

  it("accepts the bot's own mode and refuses one the provider doesn't have", () => {
    expect(narrowed("acceptEdits", "acceptEdits").ok).toBe(true);
    expect(codes(narrowed("acceptEdits", "nonsense"))).toEqual(["mode_not_on_provider"]);
  });

  it("cannot narrow without knowing the modes", () => {
    const resolution = resolveBotConfig({
      policies: [],
      global: null,
      team: null,
      bot: bot("acceptEdits"),
      routine: { modeId: "default" },
    });
    expect(codes(resolution)).toEqual(["approval_unverifiable"]);
  });

  it("lets a routine that moves provider keep the bot's approval checks", () => {
    const resolution = resolve({
      bot: makeBot({ provider: "claude", modeId: null }),
      routine: { overrides: { provider: "omp" } },
    });
    expect(codes(resolution)).toEqual(["approval_changed"]);
  });
});

describe("what a bot may inherit", () => {
  it("closes the set: a model goes with its provider and a level with its model", () => {
    expect(closeInheritance(["provider"])).toEqual(["provider", "model", "thinkingOptionId"]);
    expect(closeInheritance(["model"])).toEqual(["model", "thinkingOptionId"]);
    expect(closeInheritance(["thinkingOptionId"])).toEqual(["thinkingOptionId"]);
  });

  it("rejects a saved bot that inherits a provider but keeps its model", () => {
    const parse = (inherit: string[]) =>
      BotSchema.safeParse({ ...makeBot(), policy: { binding: null, inherit } }).success;
    expect(parse(["provider"])).toBe(false);
    expect(parse(["provider", "model", "thinkingOptionId"])).toBe(true);
    expect(parse(["model"])).toBe(false);
  });

  it("clears to inherit without touching the binding or the bot's stored values", () => {
    const bot = makeBot({ provider: "omp", model: "pi", policy: { binding: follow("pol-a"), inherit: [] } });
    const cleared = unsetOverrides(bot, ["model"]);
    expect(cleared.policy).toEqual({ binding: follow("pol-a"), inherit: ["model", "thinkingOptionId"] });
    expect(cleared.provider).toBe("omp");
    expect(unsetOverrides(cleared, ["model"])).toEqual(cleared);
  });
});

describe("who uses a policy", () => {
  it("lists the global setting, teams and bots, whichever revision they follow or pin", () => {
    const team = { id: "t1", name: "Ops", policy: { policyId: "pol-a", revision: 2 } } as BotGroup;
    const referrers = policyReferrers(
      {
        globalPolicy: follow("pol-a"),
        groups: [team, { id: "t2", name: "Other", policy: follow("pol-b") } as BotGroup],
        bots: [
          makeBot({
            id: "b1",
            name: "One",
            policy: { binding: { policyId: "pol-a", revision: 1 }, inherit: [] },
          }),
          makeBot({ id: "b2", name: "Two" }),
        ],
      },
      "pol-a",
    );
    expect(referrers).toEqual([
      { kind: "global" },
      { kind: "team", id: "t1", name: "Ops" },
      { kind: "bot", id: "b1", name: "One" },
    ]);
  });
});

describe("provider transition validation for bulk changes", () => {
  it("checks the before configuration even when the edited bot already names its target provider", () => {
    const before = makeBot({ provider: "claude", modeId: null });
    const after = { ...before, provider: "omp" };
    expect(resolve({ bot: after }).ok).toBe(true);
    expect(validateProviderTransition(before, after.provider, providers).map((issue) => issue.code)).toEqual([
      "approval_changed",
    ]);
  });

  it("accepts a different provider with the same listed approval tier and mode", () => {
    const source = providers.find((entry) => entry.id === "claude");
    if (!source) throw new Error("Missing fixture provider");
    const facts = [...providers, { ...source, id: "clone" }];
    expect(validateProviderTransition(makeBot({ modeId: "default" }), "clone", facts)).toEqual([]);
  });

  it("rejects a provider that drops explicit tool grants even when its approval tier matches", () => {
    const source = providers.find((entry) => entry.id === "claude");
    if (!source) throw new Error("Missing fixture provider");
    const facts = [...providers, { ...source, id: "clone" }];
    const before = makeBot({ modeId: "default", alwaysAllow: ["files/read"] });
    expect(validateProviderTransition(before, "clone", facts).map((issue) => issue.code)).toEqual([
      "grants_not_preserved",
    ]);
  });
});

describe("delegated role inheritance", () => {
  it("inherits selector leaves with their own sources and explicitly disables a role with null", () => {
    const global = policy("pol-global", 1, {
      roles: { reviewer: { provider: "claude", model: "opus", requirements: [{ capability: "vision" }] } },
    });
    const team = policy("pol-team", 1, { roles: { reviewer: { model: null } } });
    const result = resolve({ policies: [global, team], global: follow(global.id), team: follow(team.id) });
    expect(result.roles.reviewer.provider).toEqual({
      value: "claude",
      source: { layer: "global", policyId: global.id, revision: 1 },
    });
    expect(result.roles.reviewer.model).toEqual({
      value: null,
      source: { layer: "team", policyId: team.id, revision: 1 },
    });
    expect(result.roles.reviewer.requirements.value).toEqual([{ capability: "vision" }]);
    const disabled = policy("pol-disabled", 1, { roles: { reviewer: null } });
    const cleared = resolve({
      policies: [global, disabled],
      global: follow(global.id),
      team: follow(disabled.id),
    });
    expect(cleared.roles.reviewer.enabled.value).toBe(false);
    expect(cleared.roles.reviewer.provider.value).toBeNull();
    expect(cleared.roles.reviewer.requirements.value).toEqual([]);
  });
});

describe("explicit settings edits after adopting a policy", () => {
  it("takes ownership of the edited model without dropping the policy binding or unrelated inheritance", () => {
    const before = unsetOverrides(makeBot({ policy: { binding: follow("pol-work"), inherit: [] } }), [
      "provider",
    ]);
    const after = patchBotOverrides(before, { model: "chosen-model" });
    expect(after.policy).toEqual({ binding: follow("pol-work"), inherit: ["thinkingOptionId"] });
    expect(after.model).toBe("chosen-model");
    expect(patchBotOverrides(before, { name: "Renamed" }).policy).toEqual(before.policy);
  });

  it("refuses a missing routine rather than launching with the bot's broader permissions", () => {
    expect(resolveBot({}, makeBot(), { routineId: "gone" }).issues.map((issue) => issue.code)).toEqual([
      "unknown_routine",
    ]);
  });
});
