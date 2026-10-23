import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { librarySkillPath, readSkill, sha256 } from "../server/library";
import { newOperation } from "../server/operations";
import { acceptProposal, createProposal, getProposal, recoverProposals } from "../server/proposals";
import { MAX_RECEIPTS } from "../shared/changes/receipt";
import { useTempPaseoHome } from "./helpers";
import { commands, dyingAfterCommit, routineProposal, seeded } from "./replay-fixtures";

async function skill(name: string, text: string) {
  return createProposal({
    botId: "bot-a",
    agentId: "chat",
    kind: "skill",
    data: { name, text, description: "Recovery fixture" },
  });
}

async function changeProposalText(id: string, text: string): Promise<void> {
  const path = join(pluginDataPath(), "proposals.json");
  const file = JSON.parse(await readFile(path, "utf8")) as {
    proposals: { id: string; data: { text: string } }[];
  };
  for (const entry of file.proposals) if (entry.id === id) entry.data.text = text;
  await writeFile(path, JSON.stringify(file));
}

const staged = (id: string) => join(pluginDataPath(), "staging", "skills", id, "SKILL.md");

describe("unresolved receipts survive later operations", () => {
  useTempPaseoHome("paseo-bots-pinned-");

  it("never reapplies a committed pending proposal after the receipt eviction boundary", async () => {
    const store = await seeded();
    const proposal = await routineProposal();
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const before = (await store.read()).values.bots;
    for (let n = 0; n <= MAX_RECEIPTS; n++) {
      await store.apply(newOperation({ id: `later-${n}`, kind: "later", body: n }), (values) => ({ values }));
    }
    await acceptProposal(proposal.id, { store, commands });
    expect((await store.read()).values.bots).toEqual(before);
    expect((await store.read()).values.receipts?.length).toBeLessThanOrEqual(MAX_RECEIPTS);
  });
});

describe("skill publication reconciles current content", () => {
  useTempPaseoHome("paseo-bots-publication-");

  it("never overwrites a later accepted skill when recovering an older commit", async () => {
    const store = await seeded();
    const old = await skill("later-accepted", "old text");
    await expect(acceptProposal(old.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const newer = await skill("later-accepted", "new text");
    await acceptProposal(newer.id, { store, commands });
    const recovery = await recoverProposals(store);
    expect((await readSkill({ id: "later-accepted" })).text).toBe("new text");
    expect((await store.read()).values.library?.skills[0]?.reviewedSha).toBe(sha256("new text"));
    expect(recovery.conflicts).toContain(old.id);
    expect(await readFile(staged(old.id), "utf8")).toBe("old text");
  });

  it("recovers only the current skill when two commits are awaiting publication", async () => {
    const store = await seeded();
    const old = await skill("two-pending", "old pending text");
    const newer = await skill("two-pending", "new pending text");
    for (const proposal of [old, newer]) {
      await expect(
        acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands }),
      ).rejects.toThrow();
    }
    const recovery = await recoverProposals(store);
    expect(recovery.conflicts).toContain(old.id);
    expect(recovery.accepted).toContain(newer.id);
    expect((await readSkill({ id: "two-pending" })).sha).toBe(sha256("new pending text"));
    expect((await store.read()).values.library?.skills[0]?.reviewedSha).toBe(sha256("new pending text"));
    expect(await readFile(staged(old.id), "utf8")).toBe("old pending text");
  });
});

describe("conflicting proposals preserve their committed artifacts", () => {
  useTempPaseoHome("paseo-bots-staging-conflict-");

  it("checks the receipt before staging and retains conflicting staging through recovery", async () => {
    const store = await seeded();
    const proposal = await skill("conflicting", "committed text");
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    await changeProposalText(proposal.id, "tampered text");
    await expect(acceptProposal(proposal.id, { store, commands })).rejects.toThrow("different content");
    expect(await readFile(staged(proposal.id), "utf8")).toBe("committed text");
    const recovery = await recoverProposals(store);
    expect(recovery.conflicts).toContain(proposal.id);
    expect(await readFile(staged(proposal.id), "utf8")).toBe("committed text");
    expect((await getProposal(proposal.id))?.status).toBe("pending");
  });

  it("retains the original artifact when recovery finds a mismatching proposal", async () => {
    const store = await seeded();
    const proposal = await skill("recovery-conflicting", "recoverable text");
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    await changeProposalText(proposal.id, "changed text");
    expect((await recoverProposals(store)).conflicts).toContain(proposal.id);
    expect(await readFile(staged(proposal.id), "utf8")).toBe("recoverable text");
  });
});

describe("intervening live and staged skill edits", () => {
  useTempPaseoHome("paseo-bots-file-conflict-");

  it("preserves an intervening live edit rather than treating it as the admitted predecessor", async () => {
    const store = await seeded();
    const proposal = await skill("externally-edited", "committed content");
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const live = join(librarySkillPath("externally-edited"), "SKILL.md");
    await mkdir(librarySkillPath("externally-edited"), { recursive: true });
    await writeFile(live, "intervening edit");
    const recovery = await recoverProposals(store);
    expect(recovery.conflicts).toContain(proposal.id);
    expect(await readFile(live, "utf8")).toBe("intervening edit");
    expect(await readFile(staged(proposal.id), "utf8")).toBe("committed content");
    expect((await store.read()).values.pendingOperations).toContain(proposal.id);
  });

  it("quarantines a changed staged file instead of silently replacing or deleting it", async () => {
    const store = await seeded();
    const proposal = await skill("damaged-stage", "committed original");
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    await writeFile(staged(proposal.id), "different staged content");
    expect((await recoverProposals(store)).conflicts).toContain(proposal.id);
    expect(await readFile(staged(proposal.id), "utf8")).toBe("different staged content");
    expect((await readSkill({ id: "damaged-stage" })).missing).toBe(true);
  });
});
