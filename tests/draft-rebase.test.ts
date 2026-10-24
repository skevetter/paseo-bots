import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acknowledgeDrafts,
  applyDrafts,
  type BotDrafts,
  captureDraft,
  DraftConflictError,
  stageDrafts,
} from "../client/bot-drafts";
import { applyAutomationChange, previewAutomationChange } from "../server/automation-changes";
import { automationTargets } from "../server/automation-targets";
import { BotsHost } from "../server/host";
import { BotStore } from "../server/state";
import type { Bot } from "../shared/bot";
import { defined, makeBot, NOW } from "./helpers";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "bots-draft-rebase-"));
  directories.push(directory);
  const store = new BotStore(join(directory, "state.json"));
  await store.update((values) => ({
    ...values,
    bots: [
      makeBot({
        title: "original",
        routines: [
          {
            id: "routine-one",
            name: "Routine",
            prompt: "private prompt",
            enabled: true,
            schedule: { kind: "webhook" },
            resultsChatId: null,
            createdAt: NOW,
          },
        ],
      }),
    ],
  }));
  return { store, host: new BotsHost(store), base: defined((await store.read()).values.bots[0]) };
}

async function pause(host: BotsHost, store: BotStore) {
  const snapshot = await store.read();
  const request = {
    operationId: "pause-before-delayed-draft",
    revision: snapshot.revision,
    targetIds: [...automationTargets(snapshot.values).keys()],
    enabled: false,
  };
  const shown = await previewAutomationChange(host, request);
  if (shown.status !== "previewed") throw new Error(shown.error);
  const result = await applyAutomationChange(host, { request, previewDigest: shown.preview.digest });
  if (result.status !== "applied") throw new Error(JSON.stringify(result));
  return result.receipt;
}

async function persist(store: BotStore, pending: BotDrafts) {
  const fresh = await store.read();
  const result = await store.write(fresh.revision, applyDrafts(fresh.values, pending));
  if (result.status !== "saved") throw new Error("Unexpected fixture CAS conflict");
  return result;
}

describe("pending bot edits over atomic routine changes", () => {
  it("saves an unrelated title without undoing an acknowledged pause or its receipt", async () => {
    const { host, store, base } = await fixture();
    const pending = { [base.id]: captureDraft(base, { title: "local title" }) };
    const stale = await store.read();
    const outgoing = applyDrafts(stale.values, pending);
    const receipt = await pause(host, store);
    expect((await store.write(stale.revision, outgoing)).status).toBe("conflict");
    const fresh = await store.read();
    const saved = await store.write(fresh.revision, applyDrafts(fresh.values, pending));
    expect(saved.status).toBe("saved");
    const after = await store.read();
    const bot = defined(after.values.bots[0]);
    expect(bot.title).toBe("local title");
    expect(defined(bot.routines[0]).enabled).toBe(false);
    expect(after.values.receipts).toEqual([receipt]);
  });
});

describe("conservative field rebasing", () => {
  it("retains a conflicting title draft without writing over the saved title", async () => {
    const { store, base } = await fixture();
    const pending = { [base.id]: captureDraft(base, { title: "local title" }) };
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, title: "other editor" })),
    }));
    const before = await store.read();
    await expect(persist(store, pending)).rejects.toMatchObject({
      conflict: { kind: "changed", fields: ["title"] },
    });
    expect(await store.read()).toEqual(before);
    expect(pending[base.id]?.value.title).toBe("local title");
  });

  it.each([
    {
      local: { model: "local-model" },
      remote: { provider: "other-provider" },
      fields: ["model", "provider"],
    },
    {
      local: { alwaysAllow: ["server/tool"] },
      remote: { modeId: "other-mode" },
      fields: ["alwaysAllow", "modeId"],
    },
  ] satisfies { local: Partial<Bot>; remote: Partial<Bot>; fields: string[] }[])(
    "refuses dependent execution edits: $fields",
    async ({ local, remote, fields }) => {
      const { store, base } = await fixture();
      const pending = stageDrafts({}, base, local, { recordHistory: false });
      await store.update((values) => ({
        ...values,
        bots: values.bots.map((bot) => ({ ...bot, ...remote })),
      }));
      const before = await store.read();
      await expect(persist(store, pending)).rejects.toMatchObject({
        conflict: { kind: "changed", fields: expect.arrayContaining(fields) },
      });
      expect(await store.read()).toEqual(before);
      expect(defined(pending[base.id]).value).toMatchObject(local);
    },
  );

  it("refuses a whole-array routine edit after pause rather than mixing old enabled booleans", async () => {
    const { host, store, base } = await fixture();
    const pending = {
      [base.id]: captureDraft(base, {
        routines: base.routines.map((routine) => ({ ...routine, name: "local rename" })),
      }),
    };
    const receipt = await pause(host, store);
    const before = await store.read();
    await expect(persist(store, pending)).rejects.toBeInstanceOf(DraftConflictError);
    expect(await store.read()).toEqual(before);
    expect(before.values.receipts).toEqual([receipt]);
    expect(defined(defined(before.values.bots[0]).routines[0]).enabled).toBe(false);
    expect(defined(defined(pending[base.id]).value.routines[0]).name).toBe("local rename");
  });

  it("does not recreate a deleted bot", async () => {
    const { store, base } = await fixture();
    const pending = { [base.id]: captureDraft(base, { title: "retained unsaved title" }) };
    await store.update((values) => ({ ...values, bots: [] }));
    const before = await store.read();
    await expect(persist(store, pending)).rejects.toMatchObject({
      conflict: { kind: "deleted", botId: base.id },
    });
    expect(await store.read()).toEqual(before);
    expect(defined(pending[base.id]).value.title).toBe("retained unsaved title");
  });

  it("refuses a replacement bot reusing the same ID", async () => {
    const { store, base } = await fixture();
    const pending = { [base.id]: captureDraft(base, { title: "old identity draft" }) };
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({
        ...bot,
        title: "replacement",
        createdAt: "2030-01-01T00:00:00.000Z",
      })),
    }));
    const before = await store.read();
    await expect(persist(store, pending)).rejects.toMatchObject({ conflict: { kind: "identity" } });
    expect(await store.read()).toEqual(before);
  });

  it("ignores timestamp-only changes and preserves unrelated fresh fields", async () => {
    const { store, base } = await fixture();
    const pending = { [base.id]: captureDraft(base, { title: "local title" }) };
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, pinned: true, updatedAt: "2030-01-01T00:00:00.000Z" })),
    }));
    const saved = await persist(store, pending);
    expect(defined(saved.values.bots[0])).toMatchObject({ title: "local title", pinned: true });
  });
});

describe("own autosave acknowledgements with later keystrokes", () => {
  it("advances V2 onto the real V1 acknowledgement without reverting an intervening pause", async () => {
    const { host, store, base } = await fixture();
    const captured = stageDrafts({}, base, { title: "V1" }, { recordHistory: true });
    const current = stageDrafts(
      captured,
      base,
      { title: "V2" },
      { recordHistory: true, inFlight: captured[base.id] },
    );
    const receipt = await pause(host, store);
    const savedV1 = await persist(store, captured);
    const remaining = acknowledgeDrafts(current, captured, savedV1.values).drafts;
    expect(defined(remaining[base.id]).base.title).toBe("V1");
    expect(defined(defined(remaining[base.id]).value.routines[0]).enabled).toBe(false);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, pinned: true })),
    }));
    const savedV2 = await persist(store, remaining);
    expect(defined(savedV2.values.bots[0])).toMatchObject({ title: "V2", pinned: true });
    expect(defined(defined(savedV2.values.bots[0]).routines[0]).enabled).toBe(false);
    expect(savedV2.values.receipts).toEqual([receipt]);
    expect(acknowledgeDrafts(remaining, remaining, savedV2.values).drafts).toEqual({});
  });

  it("retains an explicit return to the original title while V1 is saving", async () => {
    const { host, store, base } = await fixture();
    const captured = stageDrafts({}, base, { title: "V1" }, { recordHistory: true });
    const current = stageDrafts(
      captured,
      base,
      { title: base.title },
      { recordHistory: true, inFlight: captured[base.id] },
    );
    expect(defined(current[base.id]).value.title).toBe(base.title);
    const receipt = await pause(host, store);
    const savedV1 = await persist(store, captured);
    const remaining = acknowledgeDrafts(current, captured, savedV1.values).drafts;
    const savedV2 = await persist(store, remaining);
    expect(defined(savedV2.values.bots[0]).title).toBe("original");
    expect(defined(defined(savedV2.values.bots[0]).routines[0]).enabled).toBe(false);
    expect(savedV2.values.receipts).toEqual([receipt]);
    expect(acknowledgeDrafts(remaining, remaining, savedV2.values).drafts).toEqual({});
  });
});

describe("remote changes incorporated by an earlier autosave acknowledgement", () => {
  it("retains a V2 routine-array conflict after V1 rebases over an atomic pause", async () => {
    const { host, store, base } = await fixture();
    const captured = stageDrafts({}, base, { title: "V1" }, { recordHistory: true });
    const stale = await store.read();
    const outgoing = applyDrafts(stale.values, captured);
    const current = stageDrafts(
      captured,
      base,
      {
        routines: base.routines.map((routine) => ({ ...routine, name: "V2 routine name" })),
      },
      { recordHistory: true, inFlight: captured[base.id] },
    );
    const receipt = await pause(host, store);
    expect((await store.write(stale.revision, outgoing)).status).toBe("conflict");
    const savedV1 = await persist(store, captured);
    expect(defined(savedV1.values.bots[0]).title).toBe("V1");
    expect(defined(defined(savedV1.values.bots[0]).routines[0]).enabled).toBe(false);
    const acknowledgement = acknowledgeDrafts(current, captured, savedV1.values);
    const remaining = acknowledgement.drafts;
    expect(defined(acknowledgement.conflicts[base.id]).fields).toEqual(["routines"]);
    expect(defined(remaining[base.id]).base.title).toBe("V1");
    const before = await store.read();
    await expect(persist(store, remaining)).rejects.toMatchObject({ conflict: { fields: ["routines"] } });
    expect(await store.read()).toEqual(before);
    expect(before.values.receipts).toEqual([receipt]);
    expect(defined(defined(remaining[base.id]).value.routines[0]).name).toBe("V2 routine name");
    // Explicit discard/review starts a new draft from the actual saved bot, not the conflicted V2.
    const reviewed = defined(before.values.bots[0]);
    const recovered = stageDrafts(
      {},
      reviewed,
      {
        routines: reviewed.routines.map((routine) => ({ ...routine, name: "V2 routine name" })),
      },
      { recordHistory: true },
    );
    const savedAfterReview = await persist(store, recovered);
    expect(defined(defined(savedAfterReview.values.bots[0]).routines[0])).toMatchObject({
      name: "V2 routine name",
      enabled: false,
    });
    expect(savedAfterReview.values.receipts).toEqual([receipt]);
  });

  it.each([
    { local: { model: "V2-model" }, remote: { provider: "remote-provider" }, fields: ["model", "provider"] },
    {
      local: { alwaysAllow: ["server/tool"] },
      remote: { modeId: "remote-mode" },
      fields: ["alwaysAllow", "modeId"],
    },
  ] satisfies { local: Partial<Bot>; remote: Partial<Bot>; fields: string[] }[])(
    "retains V2 execution dependency conflicts incorporated by V1: $fields",
    async ({ local, remote, fields }) => {
      const { store, base } = await fixture();
      const captured = stageDrafts({}, base, { title: "V1" }, { recordHistory: true });
      const current = stageDrafts(captured, base, local, {
        recordHistory: true,
        inFlight: captured[base.id],
      });
      await store.update((values) => ({
        ...values,
        bots: values.bots.map((bot) => ({ ...bot, ...remote })),
      }));
      const savedV1 = await persist(store, captured);
      expect(defined(savedV1.values.bots[0])).toMatchObject({ title: "V1", ...remote });
      const acknowledgement = acknowledgeDrafts(current, captured, savedV1.values);
      const remaining = acknowledgement.drafts;
      expect(defined(acknowledgement.conflicts[base.id]).fields).toEqual(expect.arrayContaining(fields));
      const before = await store.read();
      await expect(persist(store, remaining)).rejects.toMatchObject({
        conflict: { fields: expect.arrayContaining(fields) },
      });
      expect(await store.read()).toEqual(before);
      expect(defined(remaining[base.id]).value).toMatchObject(local);
    },
  );
});
