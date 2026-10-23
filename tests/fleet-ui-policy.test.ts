import { describe, expect, it } from "vitest";
import {
  createPolicyEditor,
  parsePolicyDraft,
  policyEditorReducer,
  policyReferrerLabel,
} from "../client/fleet/policy-editor";
import { PolicySchema, type Referrer } from "../shared/policies";

const original = PolicySchema.parse({
  id: "pol-work",
  revision: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  name: "Work",
  purpose: "Daily tasks",
  roles: { executor: { provider: "custom/provider", model: "custom:model", thinkingOptionId: "deep" } },
});

function draftWith(advanced: unknown) {
  return { name: "Work", purpose: "Daily tasks", advanced: JSON.stringify(advanced) };
}

describe("policy editor consumer schema", () => {
  it("distinguishes inheritance, provider defaults, disabled roles and unlimited limits", () => {
    const explicit = parsePolicyDraft(
      draftWith({
        roles: { executor: { model: null, thinkingOptionId: null }, advisor: null },
        budget: { maxRunCostUsd: null },
        concurrency: { maxConcurrentRuns: null },
      }),
    );
    expect(explicit).toEqual({
      ok: true,
      policy: {
        name: "Work",
        purpose: "Daily tasks",
        roles: { executor: { model: null, thinkingOptionId: null }, advisor: null },
        budget: { maxRunCostUsd: null },
        concurrency: { maxConcurrentRuns: null },
      },
    });
    const inherited = parsePolicyDraft(draftWith({}));
    expect(inherited).toEqual({
      ok: true,
      policy: { name: "Work", purpose: "Daily tasks", roles: {}, budget: {}, concurrency: {} },
    });
  });

  it("accepts all roles, routing, capabilities and task limits without a provider/model allowlist", () => {
    const selector = {
      provider: "new-provider/custom",
      model: "not-in-a-catalog",
      thinkingOptionId: "unlisted-thinking",
      requirements: [{ capability: "workspace_files" }],
    };
    const advanced = {
      taskClasses: ["research", "coding"],
      roles: {
        executor: selector,
        planner: selector,
        advisor: selector,
        verifier: selector,
        reviewer: selector,
      },
      routing: [{ id: "research", taskClasses: ["research"], role: "planner", select: selector }],
      budget: { maxRunSeconds: 120, maxRunTokens: 5000, maxRunCostUsd: 0.25 },
      concurrency: { maxConcurrentRuns: 3 },
    };
    const result = parsePolicyDraft(draftWith(advanced));
    expect(result).toEqual({ ok: true, policy: { name: "Work", purpose: "Daily tasks", ...advanced } });
  });

  it.each([
    ["executor null", { roles: { executor: null } }, "roles.executor"],
    ["provider null", { roles: { executor: { provider: null } } }, "roles.executor.provider"],
    ["permission injection", { roles: { executor: { modeId: "full" } } }, "roles.executor"],
    ["top-level permissions", { modeId: "full" }, "Policy"],
    ["metadata injection", { revision: 2 }, "Policy"],
    ["negative budget", { budget: { maxRunCostUsd: -1 } }, "budget.maxRunCostUsd"],
    ["zero concurrency", { concurrency: { maxConcurrentRuns: 0 } }, "concurrency.maxConcurrentRuns"],
    ["empty allowed classes", { taskClasses: [] }, "taskClasses"],
  ])("reports the consumer field for %s", (_name, advanced, field) => {
    const result = parsePolicyDraft(draftWith(advanced));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(field);
  });

  it("refuses malformed JSON, non-objects and names hidden in advanced settings", () => {
    const draft = draftWith({});
    expect(parsePolicyDraft({ ...draft, advanced: "{" }).ok).toBe(false);
    expect(parsePolicyDraft({ ...draft, advanced: "[]" }).ok).toBe(false);
    expect(parsePolicyDraft(draftWith({ name: "Override" })).ok).toBe(false);
    const missingName = parsePolicyDraft({ ...draft, name: "   " });
    expect(missingName.ok).toBe(false);
    if (!missingName.ok) expect(missingName.error).toContain("name");
  });
});

describe("policy editor transitions", () => {
  it("keeps a conflicted draft and its captured state revision until explicit reload", () => {
    let state = createPolicyEditor("state-old", original);
    state = policyEditorReducer(state, { type: "edit", patch: { name: "My changes" } });
    state = policyEditorReducer(state, { type: "confirm-delete", value: true });
    state = policyEditorReducer(state, {
      type: "refused",
      result: { status: "conflict", error: "State changed" },
    });
    expect(state).toMatchObject({
      revision: "state-old",
      policy: original,
      draft: { name: "My changes" },
      conflict: true,
      confirmDelete: false,
    });
    const edited = policyEditorReducer(state, { type: "edit", patch: { purpose: "Still unsaved" } });
    expect(edited.conflict).toBe(true);
    expect(edited.revision).toBe("state-old");
    expect(edited.notice).toContain("State changed");
    const reloaded = createPolicyEditor("state-new", {
      ...original,
      revision: 2,
      name: "Someone else's edit",
    });
    expect(reloaded).toMatchObject({
      conflict: false,
      revision: "state-new",
      draft: { name: "Someone else's edit" },
    });
  });

  it("advances the saved base without mutating an earlier policy revision", () => {
    const initial = createPolicyEditor("state-one", original);
    const edited = policyEditorReducer(initial, { type: "edit", patch: { name: "Work v2" } });
    const next = { ...original, name: "Work v2", revision: 2 };
    const saved = policyEditorReducer(edited, { type: "saved", revision: "state-two", policy: next });
    expect(saved).toMatchObject({
      revision: "state-two",
      policy: next,
      draft: { name: "Work v2" },
      conflict: false,
    });
    expect(initial.policy).toMatchObject({ revision: 1, name: "Work" });
    expect(initial.draft.name).toBe("Work");
  });

  it("shows every delete referrer with IDs that disambiguate identical names", () => {
    const referrers: Referrer[] = [
      { kind: "global" },
      { kind: "team", id: "ops", name: "Work" },
      ...Array.from(
        { length: 100 },
        (_, index): Referrer => ({ kind: "bot", id: `opaque-${index}`, name: "Work" }),
      ),
    ];
    const confirmed = policyEditorReducer(createPolicyEditor("state-one", original), {
      type: "confirm-delete",
      value: true,
    });
    const refused = policyEditorReducer(confirmed, {
      type: "refused",
      result: { status: "referenced", referrers },
    });
    expect(refused.confirmDelete).toBe(false);
    expect(refused.policy).toEqual(original);
    expect(refused.revision).toBe("state-one");
    expect(refused.referrers.map(policyReferrerLabel)).toEqual([
      "Global policy binding",
      "Team: Work (ops)",
      ...Array.from({ length: 100 }, (_, index) => `Bot: Work (opaque-${index})`),
    ]);
  });
});
