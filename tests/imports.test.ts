import { describe, expect, it } from "vitest";
import { applyImportedBots } from "../server/imports";
import type { ImportedEntry } from "../server/share";
import { BotStore } from "../server/state";
import { INHERITABLE, PolicySchema, resolveBot } from "../shared/policies";
import { makeBot, NOW, useTempPaseoHome } from "./helpers";

function importedEntry(): ImportedEntry {
  const policy = PolicySchema.parse({
    id: "pol-portable",
    revision: 1,
    name: "Portable runtime",
    createdAt: NOW,
    roles: { executor: { provider: "omp", model: "portable-model" } },
    budget: { maxRunCostUsd: 2 },
  });
  return {
    bot: makeBot({
      id: "bot-arrived",
      provider: "omp",
      policy: { binding: { policyId: policy.id, revision: 1 }, inherit: [...INHERITABLE] },
    }),
    policies: [policy],
    skills: [],
    mcpServers: [],
  };
}

describe("atomic portable imports", () => {
  useTempPaseoHome("paseo-bots-import-admission-");

  it("saves definitions and bound bots together, reopens, and replays after later edits", async () => {
    const store = new BotStore();
    const input = {
      operationId: "import-once",
      revision: (await store.read()).revision,
      bots: [importedEntry()],
      teams: [],
    };
    const saved = await applyImportedBots(store, input);
    expect(saved.status).toBe("saved");
    const reopened = new BotStore();
    const snapshot = await reopened.read();
    const bot = snapshot.values.bots[0];
    if (!bot) throw new Error("Missing admitted bot");
    expect(resolveBot(snapshot.values, bot).model.value).toBe("portable-model");
    expect(snapshot.values.policies).toHaveLength(1);
    await reopened.update((values) => ({
      ...values,
      bots: values.bots.map((entry) => ({ ...entry, title: "Later title" })),
    }));
    const beforeReplay = await reopened.read();
    const replayed = await applyImportedBots(reopened, input);
    expect(replayed).toEqual({ status: "saved", ...beforeReplay });
  });

  it("does not commit policy definitions or bots over a stale state revision", async () => {
    const store = new BotStore();
    const initial = await store.read();
    await store.update((values) => ({ ...values, bots: [makeBot({ id: "bot-other" })] }));
    const before = await store.read();
    expect(
      (
        await applyImportedBots(store, {
          operationId: "import-stale",
          revision: initial.revision,
          bots: [importedEntry()],
          teams: [],
        })
      ).status,
    ).toBe("conflict");
    expect(await store.read()).toEqual(before);
  });

  it("refuses changed content under one operation id without changing the admitted bot", async () => {
    const store = new BotStore();
    const input = {
      operationId: "import-content",
      revision: (await store.read()).revision,
      bots: [importedEntry()],
      teams: [],
    };
    await applyImportedBots(store, input);
    const before = await store.read();
    const bot = input.bots[0];
    if (!bot) throw new Error("Missing input bot");
    expect(
      (await applyImportedBots(store, { ...input, bots: [{ ...bot, bot: { ...bot.bot, name: "Changed" } }] }))
        .status,
    ).toBe("conflict");
    expect(await store.read()).toEqual(before);
  });

  it("rejects duplicate bot ids before any policy or configuration is written", async () => {
    const store = new BotStore();
    const before = await store.read();
    const entry = importedEntry();
    expect(
      (
        await applyImportedBots(store, {
          operationId: "import-duplicate",
          revision: before.revision,
          bots: [entry, entry],
          teams: [],
        })
      ).status,
    ).toBe("conflict");
    expect(await store.read()).toEqual(before);
  });
});
