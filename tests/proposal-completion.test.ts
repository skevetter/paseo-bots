import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { readSkill } from "../server/library";
import { newOperation } from "../server/operations";
import {
  acceptProposal,
  createProposal,
  dismissProposal,
  getProposal,
  recoverProposals,
} from "../server/proposals";
import { defined, useTempPaseoHome } from "./helpers";
import { commands, dyingAfterCommit, seeded } from "./replay-fixtures";

// These crashes occur after the receipt has made the configuration authoritative.
describe("committed proposal completion", () => {
  useTempPaseoHome("paseo-bots-completion-");

  it("refuses dismissal of a committed skill and recovers its publication and receipt pin", async () => {
    const store = await seeded();
    const text = "---\nname: durable\ndescription: Keeps committed text\n---\nCommitted instructions.\n";
    const proposal = await createProposal({
      botId: "bot-a",
      agentId: "chat",
      kind: "skill",
      data: { name: "durable", description: "Keeps committed text", text },
    });
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    await expect(dismissProposal(proposal.id, store)).rejects.toThrow(/committed/i);
    expect((await getProposal(proposal.id))?.status).toBe("pending");
    expect((await store.read()).values.pendingOperations).toContain(proposal.id);
    expect((await recoverProposals(store)).accepted).toContain(proposal.id);
    expect((await readSkill({ id: "durable" })).text).toBe(text);
    expect((await store.read()).values.pendingOperations ?? []).not.toContain(proposal.id);
  });

  it("keeps an accepted completion record through retention until receipt unpinning is durable", async () => {
    const store = await seeded();
    const proposal = await createProposal({
      botId: "bot-a",
      agentId: "chat",
      kind: "routine",
      data: {
        name: "Only once",
        prompt: "Check",
        schedule: { kind: "interval", minutes: 60 },
        resultsChatId: null,
      },
    });
    await expect(
      acceptProposal(proposal.id, {
        commands,
        store: {
          read: () => store.read(),
          apply: (operation, run) => store.apply(operation, run),
          reconcileOperation: (operation, reconcile) => store.reconcileOperation(operation, reconcile),
          completeOperation: async () => {
            throw new Error("unpin write failed");
          },
        },
      }),
    ).rejects.toThrow("unpin write failed");
    expect((await getProposal(proposal.id))?.status).toBe("accepted");
    for (let n = 0; n < 200; n++) {
      const filler = await createProposal({
        botId: "bot-a",
        agentId: "chat",
        kind: "command",
        data: { command: `echo ${n}`, cwd: "/tmp" },
      });
      await acceptProposal(filler.id, { store, commands });
    }
    expect(defined(await getProposal(proposal.id)).status).toBe("accepted");
    expect((await store.read()).values.pendingOperations).toContain(proposal.id);
    await recoverProposals(store);
    expect((await store.read()).values.pendingOperations ?? []).not.toContain(proposal.id);
    expect((await store.read()).values.bots[0]?.routines.map(({ name }) => name)).toEqual(["Only once"]);
    await createProposal({
      botId: "bot-a",
      agentId: "chat",
      kind: "command",
      data: { command: "echo done", cwd: "/tmp" },
    });
    expect(await getProposal(proposal.id)).toBeNull();
  });
});

describe("interrupted completion recovery", () => {
  useTempPaseoHome("paseo-bots-completion-recovery-");

  it("recovers committed work dismissed by an older version", async () => {
    const store = await seeded();
    const text = "Recovered committed instructions.";
    const proposal = await createProposal({
      botId: "bot-a",
      agentId: "chat",
      kind: "skill",
      data: { name: "old-dismissal", description: "Historical completion", text },
    });
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const path = join(pluginDataPath(), "proposals.json");
    const saved = JSON.parse(await readFile(path, "utf8"));
    saved.proposals[0].status = "dismissed";
    await writeFile(path, JSON.stringify(saved));
    expect((await recoverProposals(store)).accepted).toContain(proposal.id);
    expect((await getProposal(proposal.id))?.status).toBe("accepted");
    expect((await readSkill({ id: "old-dismissal" })).text).toBe(text);
    expect((await store.read()).values.pendingOperations ?? []).not.toContain(proposal.id);
  });

  it("finishes a lost completion mark even after the already-unpinned receipt was evicted", async () => {
    const store = await seeded();
    const proposal = await createProposal({
      botId: "bot-a",
      agentId: "chat",
      kind: "routine",
      data: {
        name: "Once",
        prompt: "Check",
        schedule: { kind: "interval", minutes: 60 },
        resultsChatId: null,
      },
    });
    await expect(
      acceptProposal(proposal.id, {
        commands,
        store: {
          read: () => store.read(),
          apply: (operation, run) => store.apply(operation, run),
          reconcileOperation: (operation, reconcile) => store.reconcileOperation(operation, reconcile),
          completeOperation: async (operation) => {
            await store.completeOperation(operation);
            throw new Error("crash after unpin");
          },
        },
      }),
    ).rejects.toThrow("crash after unpin");
    for (let n = 0; n < 200; n++)
      await store.apply(newOperation({ id: `after-unpin-${n}`, kind: "fixture", body: n }), (values) => ({
        values,
      }));
    expect((await store.read()).values.receipts?.some(({ operationId }) => operationId === proposal.id)).toBe(
      false,
    );
    await recoverProposals(store);
    expect((await getProposal(proposal.id))?.completionPending).toBeUndefined();
    expect((await store.read()).values.bots[0]?.routines.map(({ name }) => name)).toEqual(["Once"]);
  });
});
