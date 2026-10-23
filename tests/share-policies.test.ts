import { describe, expect, it } from "vitest";
import { exportBot, exportTeam, importBot, importTeam } from "../server/share";
import { BotGroupSchema, type BotState, BotStateSchema, EMPTY_LIBRARY } from "../shared/bot";
import { addImportedBots } from "../shared/library";
import { INHERITABLE, PolicySchema, resolveBot } from "../shared/policies";
import { makeBot, NOW, useTempPaseoHome } from "./helpers";

function source() {
  const global = PolicySchema.parse({
    id: "pol-global",
    revision: 1,
    createdAt: NOW,
    name: "Global",
    roles: {
      executor: { provider: "omp", model: "global-model" },
      reviewer: { provider: "omp", model: "critic" },
    },
    budget: { maxRunCostUsd: 10, maxRunTokens: 2000 },
  });
  const team = PolicySchema.parse({
    id: "pol-team",
    revision: 1,
    createdAt: NOW,
    name: "Team",
    roles: { executor: { model: "team-model", thinkingOptionId: "high" } },
    taskClasses: ["engineering"],
    budget: { maxRunCostUsd: 3 },
    concurrency: { maxConcurrentRuns: 2 },
  });
  const bot = makeBot({
    id: "bot-source",
    name: "Portable",
    provider: "omp",
    modeId: "full",
    policy: { binding: null, inherit: [...INHERITABLE] },
    alwaysAllow: ["write_file"],
  });
  return BotStateSchema.parse({
    bots: [bot],
    policies: [global, team],
    globalPolicy: { policyId: global.id, revision: null },
    groups: [
      BotGroupSchema.parse({
        id: "team-source",
        name: "Source",
        memberIds: [bot.id],
        policy: { policyId: team.id, revision: 1 },
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
  });
}

function effective(values: BotState, botId: string) {
  const bot = values.bots.find((entry) => entry.id === botId);
  if (!bot) throw new Error("Missing fixture bot");
  const resolved = resolveBot(values, bot);
  return {
    provider: resolved.provider.value,
    model: resolved.model.value,
    thinking: resolved.thinkingOptionId.value,
    reviewer: resolved.roles.reviewer.model.value,
    classes: resolved.taskClasses.value,
    cost: resolved.budget.maxRunCostUsd.value,
    tokens: resolved.budget.maxRunTokens.value,
    concurrency: resolved.concurrency.maxConcurrentRuns.value,
  };
}

describe("portable runtime policies", () => {
  useTempPaseoHome("paseo-bots-policy-share-");

  it("keeps effective layered settings and limits without host-local policy ids or permissions", async () => {
    const values = source();
    const bot = values.bots[0];
    if (!bot) throw new Error("Missing source bot");
    const { json } = await exportBot({ bot, includeMemory: false }, EMPTY_LIBRARY, values);
    const imported = await importBot({ botId: "bot-arrived", json });
    const target = addImportedBots(BotStateSchema.parse({}), [imported]);
    expect(effective(target, imported.bot.id)).toEqual(effective(values, bot.id));
    expect(imported.bot.modeId).toBeNull();
    expect(imported.bot.alwaysAllow).toEqual([]);
    expect(imported.bot.policy?.binding?.policyId).not.toBe("pol-global");
    expect(imported.bot.policy?.binding?.policyId).not.toBe("pol-team");
    expect(target.policies).toHaveLength(1);
  });

  it("does not inherit different destination defaults or append duplicate immutable snapshots", async () => {
    const values = source();
    const { json } = await exportTeam(
      { bots: values.bots, groups: values.groups ?? [], includeMemory: false },
      EMPTY_LIBRARY,
      values,
    );
    const imported = await importTeam({ json });
    const destination = BotStateSchema.parse({
      policies: [
        PolicySchema.parse({
          id: "pol-destination",
          revision: 1,
          createdAt: NOW,
          name: "Other",
          roles: { executor: { provider: "other", model: "other" } },
          budget: { maxRunCostUsd: 999 },
        }),
      ],
      globalPolicy: { policyId: "pol-destination", revision: null },
    });
    const target = addImportedBots(destination, imported.bots, imported.teams);
    const bot = imported.bots[0]?.bot;
    if (!bot) throw new Error("Missing imported bot");
    expect(effective(target, bot.id)).toEqual(effective(values, "bot-source"));
    const second = await importTeam({ json });
    const appended = addImportedBots(target, second.bots, second.teams);
    expect(appended.policies).toEqual(target.policies);
    expect(appended.bots).toHaveLength(2);
  });

  it("refuses unresolved source bindings instead of silently exporting stale bot overrides", async () => {
    const bot = makeBot({
      policy: { binding: { policyId: "pol-missing", revision: 1 }, inherit: [...INHERITABLE] },
    });
    await expect(exportBot({ bot, includeMemory: false }, EMPTY_LIBRARY)).rejects.toThrow();
  });

  it("rejects permission fields smuggled into an imported execution policy", async () => {
    const values = source();
    const bot = values.bots[0];
    if (!bot) throw new Error("Missing source bot");
    const { json } = await exportBot({ bot, includeMemory: false }, EMPTY_LIBRARY, values);
    const file = JSON.parse(json);
    file.runtimePolicy.modeId = "full";
    await expect(importBot({ botId: "bot-crafted", json: JSON.stringify(file) })).rejects.toThrow();
  });
});
