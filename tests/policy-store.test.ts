import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { deletePolicy, getPolicy, listPolicies, savePolicy } from "../server/policies";
import { BotStore } from "../server/state";
import type { BotGroup } from "../shared/bot";
import { saveTeam } from "../shared/groups";
import { PolicyBodySchema } from "../shared/policies";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";

let files = 0;
async function create() {
  const store = new BotStore(join(pluginDataPath(), `policies-${++files}.json`));
  const snapshot = await store.read();
  const saved = await savePolicy(
    store,
    {
      revision: snapshot.revision,
      policy: PolicyBodySchema.parse({
        name: "Work",
        roles: { executor: { provider: "claude", model: "opus" } },
      }),
    },
    NOW,
  );
  if (saved.status !== "saved") throw new Error("Expected a saved policy");
  return { store, saved };
}

describe("immutable policy revisions", () => {
  useTempPaseoHome("paseo-policy-store-");

  it("keeps a pinned revision unchanged when the policy is saved again", async () => {
    const { store, saved } = await create();
    const next = await savePolicy(
      store,
      {
        revision: saved.revision,
        id: saved.policy.id,
        policy: PolicyBodySchema.parse({ name: "Work", roles: { executor: { model: "sonnet" } } }),
      },
      "2026-10-01T00:00:00.000Z",
    );
    expect(next.status).toBe("saved");
    expect((await getPolicy(store, { id: saved.policy.id, revision: 1 })).policy).toEqual(saved.policy);
    expect((await getPolicy(store, { id: saved.policy.id })).policy).toMatchObject({
      revision: 2,
      roles: { executor: { model: "sonnet" } },
    });
    expect((await listPolicies(store)).policies.map((policy) => policy.revision)).toEqual([2]);
    expect((await getPolicy(store, { id: saved.policy.id })).revisions).toEqual([1, 2]);
  });

  it("creates a revision even when a successful save submits the same body", async () => {
    const { store, saved } = await create();
    const { id: _id, revision: _revision, createdAt: _at, ...body } = saved.policy;
    const next = await savePolicy(store, { revision: saved.revision, id: saved.policy.id, policy: body });
    expect(next.status).toBe("saved");
    expect((await getPolicy(store, { id: saved.policy.id })).revisions).toEqual([1, 2]);
  });

  it("refuses a stale save rather than adding another revision", async () => {
    const { store, saved } = await create();
    await store.update((values) => ({ ...values, bots: [makeBot()] }));
    const before = await store.read();
    const attempted = await savePolicy(store, {
      revision: saved.revision,
      id: saved.policy.id,
      policy: PolicyBodySchema.parse({ name: "Changed" }),
    });
    expect(attempted.status).toBe("conflict");
    expect(await store.read()).toEqual(before);
  });

  it("serializes competing edits so only one adds a revision", async () => {
    const { store, saved } = await create();
    const attempts = await Promise.all(
      ["First", "Second"].map((name) =>
        savePolicy(store, {
          revision: saved.revision,
          id: saved.policy.id,
          policy: PolicyBodySchema.parse({ name }),
        }),
      ),
    );
    expect(attempts.map((attempt) => attempt.status)).toEqual(["saved", "conflict"]);
    expect((await getPolicy(store, { id: saved.policy.id })).policy?.name).toBe("First");
  });

  it("does not let whole-state writes forge or replace saved revisions", async () => {
    const { store, saved } = await create();
    const before = await store.read();
    await store.write(before.revision, { ...before.values, policies: [{ ...saved.policy, name: "Forged" }] });
    expect((await getPolicy(store, { id: saved.policy.id })).policy?.name).toBe("Work");
    await store.update((values) => ({ ...values, policies: [] }));
    expect((await getPolicy(store, { id: saved.policy.id })).policy).toEqual(saved.policy);
  });
});

describe("deleting policies", () => {
  useTempPaseoHome("paseo-policy-delete-");

  it("refuses deletion with every bot, team and global referrer, including pinned bindings", async () => {
    const { store, saved } = await create();
    const binding = { policyId: saved.policy.id, revision: 1 };
    const team: BotGroup = {
      id: "ops",
      name: "Ops",
      logo: null,
      leadId: null,
      memberIds: [],
      instructions: "",
      createdAt: NOW,
      updatedAt: NOW,
      policy: binding,
    };
    const bound = await store.update((values) => ({
      ...values,
      globalPolicy: binding,
      groups: [team],
      bots: [makeBot({ policy: { binding, inherit: [] } })],
    }));
    const refused = await deletePolicy(store, { revision: bound.revision, id: saved.policy.id });
    expect(refused).toEqual({
      status: "referenced",
      referrers: [
        { kind: "global" },
        { kind: "team", id: "ops", name: "Ops" },
        { kind: "bot", id: "bot-1", name: "Inbox" },
      ],
    });
    expect(await store.read()).toEqual(bound);
  });

  it("deletes an unbound policy and all its revisions in one state transition", async () => {
    const { store, saved } = await create();
    const next = await savePolicy(store, {
      revision: saved.revision,
      id: saved.policy.id,
      policy: PolicyBodySchema.parse({ name: "Revised" }),
    });
    if (next.status !== "saved") throw new Error("Expected revision 2");
    const result = await deletePolicy(store, { revision: next.revision, id: saved.policy.id });
    expect(result.status).toBe("deleted");
    expect(await getPolicy(store, { id: saved.policy.id })).toEqual({ policy: null, revisions: [] });
    expect((await store.read()).values.policies).toBeUndefined();
  });

  it("refuses a stale deletion after a binding is added", async () => {
    const { store, saved } = await create();
    const bound = await store.update((values) => ({
      ...values,
      globalPolicy: { policyId: saved.policy.id, revision: null },
    }));
    expect((await deletePolicy(store, { revision: saved.revision, id: saved.policy.id })).status).toBe(
      "conflict",
    );
    expect(await store.read()).toEqual(bound);
    expect(defined((await getPolicy(store, { id: saved.policy.id })).policy).name).toBe("Work");
  });

  it("keeps a team's binding when the existing team editor changes its name", async () => {
    const { store, saved } = await create();
    const binding = { policyId: saved.policy.id, revision: null };
    const team: BotGroup = {
      id: "ops",
      name: "Ops",
      logo: null,
      leadId: null,
      memberIds: [],
      instructions: "",
      createdAt: NOW,
      updatedAt: NOW,
      policy: binding,
    };
    const groups = saveTeam([team], {
      id: team.id,
      newId: team.id,
      now: NOW,
      draft: { name: "Operations", logo: null, leadId: null, memberIds: [], instructions: "" },
    });
    const bound = await store.update((values) => ({ ...values, groups }));
    expect(groups[0]?.name).toBe("Operations");
    expect(await deletePolicy(store, { revision: bound.revision, id: saved.policy.id })).toEqual({
      status: "referenced",
      referrers: [{ kind: "team", id: "ops", name: "Operations" }],
    });
  });
});
