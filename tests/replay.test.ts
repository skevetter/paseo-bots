import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import type * as Files from "../server/files";
import { librarySkillPath, readSkill, sha256 } from "../server/library";
import { acceptProposal, getProposal, recoverProposals } from "../server/proposals";
import { createdEntities, findReceipt } from "../shared/changes/operation";
import type { Proposal } from "../shared/proposals";
import { useTempPaseoHome } from "./helpers";
import {
  changesProposal,
  commands,
  dyingAfterCommit,
  dyingBeforeCommit,
  importProposal,
  pendingIds,
  routineProposal,
  SKILL_TEXT,
  seeded,
  skillProposal,
  stagedIds,
} from "./replay-fixtures";

/** Stands in for the process dying: the file is left as it was just before the next write to it. */
const crash = vi.hoisted(() => ({ beforeProposalWrite: false }));

vi.mock("../server/files", async (importOriginal) => {
  const files = await importOriginal<typeof Files>();
  return {
    ...files,
    writeJson: (path: string, ...rest: [unknown, number?]) => {
      if (crash.beforeProposalWrite && path.endsWith("proposals.json")) {
        crash.beforeProposalWrite = false;
        throw new Error("crash before the accept mark");
      }
      return files.writeJson(path, ...rest);
    },
  };
});

const KINDS: [string, () => Promise<Proposal>][] = [
  ["routine", routineProposal],
  ["changes", changesProposal],
  ["import", importProposal],
  ["skill", skillProposal],
];

describe.each(KINDS)("accepting a %s proposal across a crash", (_kind, create) => {
  useTempPaseoHome("paseo-bots-replay-");

  it("recovers the committed configuration without applying it again", async () => {
    const store = await seeded();
    const proposal = await create();
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow(
      "crash after the config write",
    );
    expect(await pendingIds()).toContain(proposal.id);
    const saved = await store.read();
    const receipt = findReceipt(saved.values, proposal.id);
    expect(receipt?.createdCount).toBeGreaterThan(0);

    const again = await acceptProposal(proposal.id, { store, commands });
    expect(again.proposal.status).toBe("accepted");
    expect(again.receipt).toEqual(receipt);
    const { pendingOperations: _pin, ...committed } = saved.values;
    expect((await store.read()).values).toEqual(committed);
    expect(await stagedIds()).toEqual([]);
  });

  it("does not reapply when the accept mark failed after the config commit", async () => {
    const store = await seeded();
    const proposal = await create();
    crash.beforeProposalWrite = true;
    await expect(acceptProposal(proposal.id, { store, commands })).rejects.toThrow(
      "crash before the accept mark",
    );
    expect((await getProposal(proposal.id))?.status).toBe("pending");
    const saved = await store.read();

    expect((await acceptProposal(proposal.id, { store, commands })).proposal.status).toBe("accepted");
    await expect(acceptProposal(proposal.id, { store, commands })).rejects.toThrow("already saved");
    const { pendingOperations: _pin, ...committed } = saved.values;
    expect((await store.read()).values).toEqual(committed);
  });

  it("applies once when it died before the config write", async () => {
    const store = await seeded();
    const before = await store.read();
    const proposal = await create();
    await expect(acceptProposal(proposal.id, { store: dyingBeforeCommit(store), commands })).rejects.toThrow(
      "crash before the config write",
    );
    expect((await store.read()).revision).toBe(before.revision);

    const accepted = await acceptProposal(proposal.id, { store, commands });
    const { values } = await store.read();
    expect(accepted.receipt?.created).toEqual(
      createdEntities(before.values, values).slice(0, accepted.receipt?.created.length),
    );
    expect(values.receipts).toHaveLength(1);
    expect(await stagedIds()).toEqual([]);
  });
});

describe("a proposal accepted again", () => {
  useTempPaseoHome("paseo-bots-replay-again-");

  it("makes a routine once, with the id and time of the first run", async () => {
    const store = await seeded();
    const proposal = await routineProposal();
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const routines = async () => (await store.read()).values.bots[0]?.routines ?? [];
    const [first] = await routines();
    await acceptProposal(proposal.id, { store, commands });
    expect(await routines()).toEqual([first]);
    expect(first?.id).toBe(`rt-${proposal.id}-0-0`);
    expect(first?.createdAt).toBe(findReceipt((await store.read()).values, proposal.id)?.appliedAt);
  });

  it("is refused when its id was saved with other content", async () => {
    const store = await seeded();
    const proposal = await routineProposal();
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const saved = await store.read();

    const path = join(pluginDataPath(), "proposals.json");
    const file = JSON.parse(await readFile(path, "utf8")) as {
      proposals: { id: string; data: { prompt: string } }[];
    };
    for (const entry of file.proposals) if (entry.id === proposal.id) entry.data.prompt = "Something else";
    await writeFile(path, JSON.stringify(file));

    await expect(acceptProposal(proposal.id, { store, commands })).rejects.toThrow(
      "already applied with different content",
    );
    expect((await store.read()).revision).toBe(saved.revision);
    expect((await getProposal(proposal.id))?.status).toBe("pending");
  });

  it("applies only once when accepted at the same time", async () => {
    const store = await seeded();
    const proposal = await changesProposal();
    const results = await Promise.allSettled([
      acceptProposal(proposal.id, { store, commands }),
      acceptProposal(proposal.id, { store, commands }),
      acceptProposal(proposal.id, { store, commands }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "rejected"]);
    const { values } = await store.read();
    expect(values.bots.map((bot) => bot.name)).toEqual(["Ada", "Nova"]);
    expect(values.bots[0]?.routines).toHaveLength(1);
    expect(values.presets).toHaveLength(1);
  });
});

describe("a skill's file", () => {
  useTempPaseoHome("paseo-bots-replay-skill-");

  it("stays out of the library until the config write lands", async () => {
    const store = await seeded();
    const oldText = "---\nname: Triage\ndescription: Old\n---\nOld.\n";
    await mkdir(librarySkillPath("triage"), { recursive: true });
    await writeFile(join(librarySkillPath("triage"), "SKILL.md"), oldText);
    const proposal = await skillProposal();

    await expect(
      acceptProposal(proposal.id, { store: dyingBeforeCommit(store), commands }),
    ).rejects.toThrow();
    expect((await readSkill({ id: "triage" })).text).toBe(oldText);
    expect((await store.read()).values.library?.skills ?? []).toEqual([]);
    expect(await stagedIds()).toEqual([proposal.id]);

    await acceptProposal(proposal.id, { store, commands });
    expect((await readSkill({ id: "triage" })).text).toBe(SKILL_TEXT);
    expect((await store.read()).values.library?.skills[0]?.reviewedSha).toBe(sha256(SKILL_TEXT));
    expect(await stagedIds()).toEqual([]);
  });
});

describe("recovering at startup", () => {
  useTempPaseoHome("paseo-bots-recover-");

  it("finishes a skill whose changes were saved, publishing its file", async () => {
    const store = await seeded();
    const proposal = await skillProposal();
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    expect((await readSkill({ id: "triage" })).missing).toBe(true);
    expect(await stagedIds()).toEqual([proposal.id]);

    expect(await recoverProposals(store)).toEqual({ accepted: [proposal.id], conflicts: [], discarded: [] });
    expect((await readSkill({ id: "triage" })).text).toBe(SKILL_TEXT);
    expect(await stagedIds()).toEqual([]);
    expect((await getProposal(proposal.id))?.status).toBe("accepted");
  });

  it("publishes from the verified proposal when its staged file is missing", async () => {
    const store = await seeded();
    const proposal = await skillProposal("lost-stage");
    await expect(acceptProposal(proposal.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    await rm(join(pluginDataPath(), "staging", "skills", proposal.id, "SKILL.md"));
    await recoverProposals(store);
    expect((await readSkill({ id: "lost-stage" })).text).toBe(SKILL_TEXT);
  });

  it("discards skill files staged by an operation that never saved", async () => {
    const store = await seeded();
    const proposal = await skillProposal("orphan");
    await expect(
      acceptProposal(proposal.id, { store: dyingBeforeCommit(store), commands }),
    ).rejects.toThrow();
    expect(await stagedIds()).toEqual([proposal.id]);

    expect(await recoverProposals(store)).toEqual({ accepted: [], conflicts: [], discarded: [proposal.id] });
    expect(await pendingIds()).toContain(proposal.id);
    expect((await readSkill({ id: "orphan" })).missing).toBe(true);
  });

  it("marks only the proposals whose changes were saved", async () => {
    const store = await seeded();
    const saved = await routineProposal();
    const waiting = await changesProposal();
    await expect(acceptProposal(saved.id, { store: dyingAfterCommit(store), commands })).rejects.toThrow();
    const { pendingOperations: _pin, ...committed } = (await store.read()).values;

    expect((await recoverProposals(store)).accepted).toEqual([saved.id]);
    expect((await getProposal(waiting.id))?.status).toBe("pending");
    expect((await store.read()).values).toEqual(committed);
  });
});
