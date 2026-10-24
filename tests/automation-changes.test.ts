import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyAutomationChange,
  previewAutomationChange,
  revertAutomationChange,
} from "../server/automation-changes";
import { automationTargets } from "../server/automation-targets";
import { BotsHost } from "../server/host";
import { BotStore } from "../server/state";
import {
  type AutomationChangeRequest,
  AutomationChangeRequestSchema,
  type AutomationPreview,
} from "../shared/automations";
import type { Bot, Routine } from "../shared/bot";
import type { ProviderEntry } from "../shared/changes/context";
import { MAX_RECEIPTS } from "../shared/changes/receipt";
import { defined, makeBot, NOW } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function routine(index: number, enabled = true): Routine {
  return {
    id: `opaque:routine/${index}`,
    name: "Same display name",
    prompt: `private-prompt-${index}`,
    enabled,
    schedule: { kind: "webhook" },
    resultsChatId: null,
    createdAt: NOW,
  };
}

async function fixture(
  bots: Bot[] = Array.from({ length: 101 }, (_, index) =>
    makeBot({ id: `opaque:bot/${index}`, routines: [routine(index)], soul: `private-soul-${index}` }),
  ),
  attached = true,
) {
  const directory = await mkdtemp(join(tmpdir(), "bots-automations-changes-"));
  directories.push(directory);
  const store = new BotStore(join(directory, "state.json"));
  await store.update((values) => ({ ...values, bots }));
  const host = new BotsHost(store);
  const entries: ProviderEntry[] = structuredClone(LIVE_PROVIDERS);
  if (attached) host.attach({ providers: { snapshot: async () => ({ entries }) } } as never);
  return { store, host, entries };
}

async function requestFor(
  store: BotStore,
  patch: Partial<AutomationChangeRequest> = {},
): Promise<AutomationChangeRequest> {
  const snapshot = await store.read();
  return {
    operationId: "routines-change",
    revision: snapshot.revision,
    targetIds: [...automationTargets(snapshot.values).keys()].slice(0, 100),
    enabled: false,
    ...patch,
  };
}

async function preview(host: BotsHost, request: AutomationChangeRequest): Promise<AutomationPreview> {
  const result = await previewAutomationChange(host, request);
  if (result.status !== "previewed") throw new Error(result.error);
  return result.preview;
}

async function apply(host: BotsHost, request: AutomationChangeRequest) {
  const shown = await preview(host, request);
  return applyAutomationChange(host, { request, previewDigest: shown.digest });
}

describe("routine exact-selection transactions", () => {
  it("pauses exactly 100 opaque targets and saves a private-content-free receipt in one write", async () => {
    const { store, host } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    const transitions: { paused: number; receipt: boolean }[] = [];
    store.onChange((snapshot) =>
      transitions.push({
        paused: snapshot.values.bots.filter((bot) => !defined(bot.routines[0]).enabled).length,
        receipt: !!snapshot.values.receipts?.some((receipt) => receipt.operationId === request.operationId),
      }),
    );
    const result = await applyAutomationChange(host, { request, previewDigest: shown.digest });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    expect(transitions).toEqual([{ paused: 100, receipt: true }]);
    const after = await store.read();
    expect(after.values.bots.slice(0, 100).every((bot) => !defined(bot.routines[0]).enabled)).toBe(true);
    expect(defined(defined(after.values.bots[100]).routines[0]).enabled).toBe(true);
    expect(result.receipt.automations.rows.map((row) => row.targetId)).toEqual(request.targetIds);
    expect(
      result.receipt.automations.rows.every(
        (row) => row.before && !row.after && /^[a-f0-9]{64}$/.test(row.afterHash),
      ),
    ).toBe(true);
    expect(result.receipt.originalRevision).toBe(request.revision);
    expect(result.receipt.newRevision).toBe(after.revision);
    expect(JSON.stringify(result.receipt)).not.toMatch(/private-(prompt|soul)|Same display name/);
    expect(await new BotStore(store.path).read()).toEqual(after);
    const saved = JSON.parse(await readFile(store.path, "utf8"));
    expect(saved.values.receipts[0].automations.rows).toEqual(result.receipt.automations.rows);
  });

  it("replays identical concurrent requests after unrelated edits without applying the routine transition again", async () => {
    const { host, store } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    const body = { request, previewDigest: shown.digest };
    let writes = 0;
    store.onChange(() => {
      writes++;
    });
    const results = await Promise.all([applyAutomationChange(host, body), applyAutomationChange(host, body)]);
    expect(results.map((result) => result.status).sort()).toEqual(["applied", "replayed"]);
    expect(writes).toBe(1);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, soul: "unrelated later edit" })),
    }));
    const current = await store.read();
    const replay = await applyAutomationChange(new BotsHost(new BotStore(store.path)), body);
    expect(replay.status).toBe("replayed");
    expect(await store.read()).toEqual(current);
    expect(
      await applyAutomationChange(host, { ...body, request: { ...request, enabled: true } }),
    ).toMatchObject({ status: "conflict", error: expect.stringContaining("different content") });
    expect(await store.read()).toEqual(current);
  });
});

describe("routine stale selection refusal", () => {
  it("refuses a stale preview, changed digest, missing target or duplicate target atomically", async () => {
    const { host, store } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    const before = await store.read();
    expect(await applyAutomationChange(host, { request, previewDigest: "changed-digest" })).toMatchObject({
      status: "conflict",
    });
    expect(await store.read()).toEqual(before);
    expect(
      await previewAutomationChange(host, {
        ...request,
        targetIds: [...request.targetIds, "removed-target"],
      }),
    ).toMatchObject({ status: "conflict", error: expect.stringContaining("no longer exists") });
    expect(
      await applyAutomationChange(host, {
        request: { ...request, targetIds: [defined(request.targetIds[0]), defined(request.targetIds[0])] },
        previewDigest: shown.digest,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(await store.read()).toEqual(before);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, title: "concurrent title" })),
    }));
    const later = await store.read();
    expect(await applyAutomationChange(host, { request, previewDigest: shown.digest })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("changed elsewhere"),
    });
    expect(await store.read()).toEqual(later);
  });

  it("rejects reusing the selection after a selected routine disappeared, without pausing the remaining targets", async () => {
    const { host, store } = await fixture();
    const request = await requestFor(store);
    await store.update((values) => ({
      ...values,
      bots: values.bots.filter((bot) => bot.id !== "opaque:bot/0"),
    }));
    const refreshed = { ...request, revision: (await store.read()).revision };
    const result = await previewAutomationChange(host, refreshed);
    expect(result).toMatchObject({ status: "conflict", error: expect.stringContaining("no longer exists") });
    expect((await store.read()).values.bots.every((bot) => defined(bot.routines[0]).enabled)).toBe(true);
  });
});

describe("routine resume qualification", () => {
  it("resumes exactly 100 qualified routines with one shared receipt and no lost fields", async () => {
    const { host, store } = await fixture(
      Array.from({ length: 100 }, (_, index) =>
        makeBot({ id: `bot-${index}`, routines: [routine(index, false)], title: "keep title" }),
      ),
    );
    const request = await requestFor(store, { enabled: true, operationId: "resume-hundred" });
    const writes: number[] = [];
    store.onChange((snapshot) =>
      writes.push(snapshot.values.bots.filter((bot) => defined(bot.routines[0]).enabled).length),
    );
    const result = await apply(host, request);
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    expect(writes).toEqual([100]);
    expect(result.receipt.automations.rows.every((row) => !row.before && row.after)).toBe(true);
    expect(
      (await store.read()).values.bots.every(
        (bot) => bot.title === "keep title" && defined(bot.routines[0]).prompt.startsWith("private-prompt-"),
      ),
    ).toBe(true);
  });

  it("can pause disconnected but refuses to resume without qualifying host evidence", async () => {
    const { host, store } = await fixture([makeBot({ routines: [routine(1)] })], false);
    const pause = await requestFor(store);
    expect((await apply(host, pause)).status).toBe("applied");
    const resume = await requestFor(store, { operationId: "resume-disconnected", enabled: true });
    const shown = await preview(host, resume);
    expect(shown.compatible).toBe(false);
    expect(shown.rows[0]?.incompatibilities).toContainEqual(
      expect.objectContaining({ code: "approval_unverifiable" }),
    );
    const before = await store.read();
    expect((await applyAutomationChange(host, { request: resume, previewDigest: shown.digest })).status).toBe(
      "conflict",
    );
    expect(await store.read()).toEqual(before);
  });

  it("rejects the entire resume when one selection or provider evidence cannot qualify", async () => {
    const bots = [
      makeBot({ id: "good", routines: [routine(1, false)] }),
      makeBot({ id: "bad", model: "missing-model", routines: [routine(2, false)] }),
    ];
    const { host, store } = await fixture(bots);
    const request = await requestFor(store, { enabled: true });
    const shown = await preview(host, request);
    expect(shown.compatible).toBe(false);
    expect((await applyAutomationChange(host, { request, previewDigest: shown.digest })).status).toBe(
      "conflict",
    );
    expect((await store.read()).values.bots.every((bot) => !defined(bot.routines[0]).enabled)).toBe(true);
  });

  it("uses launch's selectable first-model fallback and invalidates a resume preview if that evidence changes", async () => {
    const { host, store, entries } = await fixture([
      makeBot({ model: null, thinkingOptionId: "medium", routines: [routine(1, false)] }),
    ]);
    const provider = defined(entries.find((entry) => entry.provider === "claude"));
    provider.models = [
      {
        id: "first",
        label: "First",
        isDefault: false,
        thinkingOptions: [{ id: "medium" }],
        defaultThinkingOptionId: "medium",
      },
    ];
    const request = await requestFor(store, { enabled: true });
    const shown = await preview(host, request);
    expect(shown.compatible).toBe(true);
    provider.models = [];
    const before = await store.read();
    expect(await applyAutomationChange(host, { request, previewDigest: shown.digest })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("digest"),
    });
    expect(await store.read()).toEqual(before);
    const unavailable = await preview(host, request);
    expect(unavailable.compatible).toBe(false);
    expect(unavailable.rows[0]?.incompatibilities).toContainEqual(
      expect.objectContaining({ field: "model" }),
    );
  });
});

describe("routine audited revert and retention", () => {
  it("reverts only the enabled booleans and preserves unrelated concurrent configuration edits", async () => {
    const { host, store } = await fixture([makeBot({ routines: [routine(1), routine(2)] })]);
    const request = await requestFor(store);
    const target = defined(request.targetIds[0]);
    request.targetIds = [target];
    const result = await apply(host, request);
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({
        ...bot,
        title: "keep title",
        routines: bot.routines.map((entry) =>
          entry.id === "opaque:routine/2" ? { ...entry, prompt: "keep unrelated routine prompt" } : entry,
        ),
      })),
    }));
    const revision = (await store.read()).revision;
    const body = { operationId: "revert-enabled", revision, appliedOperationId: request.operationId };
    const reverted = await revertAutomationChange(host, body);
    expect(reverted.status).toBe("applied");
    const bot = defined((await store.read()).values.bots[0]);
    expect(bot.title).toBe("keep title");
    expect(bot.routines.map((entry) => entry.enabled)).toEqual([true, true]);
    expect(defined(bot.routines[1]).prompt).toBe("keep unrelated routine prompt");
    expect((await revertAutomationChange(host, body)).status).toBe("replayed");
  });

  it("refuses revert after an affected routine changes or re-enabling loses model qualification", async () => {
    const { host, store, entries } = await fixture([makeBot({ routines: [routine(1)] })]);
    const request = await requestFor(store);
    expect((await apply(host, request)).status).toBe("applied");
    defined(entries.find((entry) => entry.provider === "claude")).models = [];
    const before = await store.read();
    expect(
      (
        await revertAutomationChange(host, {
          operationId: "revert-no-model",
          revision: before.revision,
          appliedOperationId: request.operationId,
        })
      ).status,
    ).toBe("conflict");
    expect(await store.read()).toEqual(before);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({
        ...bot,
        routines: bot.routines.map((entry) => ({ ...entry, prompt: "new content" })),
      })),
    }));
    const later = await store.read();
    expect(
      await revertAutomationChange(host, {
        operationId: "revert-edited",
        revision: later.revision,
        appliedOperationId: request.operationId,
      }),
    ).toMatchObject({ status: "conflict", error: expect.stringContaining("changed after") });
    expect(await store.read()).toEqual(later);
  });

  it("respects shared bounded receipt pressure without losing unresolved operations", async () => {
    const { host, store } = await fixture([makeBot({ routines: [routine(1)] })]);
    for (let index = 0; index < MAX_RECEIPTS; index++)
      await store.apply(
        { id: `pending-${index}`, kind: "pending", bodyHash: "same", at: NOW, pending: true },
        (values) => ({ values }),
      );
    const request = await requestFor(store);
    const before = await store.read();
    expect(await apply(host, request)).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("unresolved"),
    });
    expect(await store.read()).toEqual(before);
    expect(
      AutomationChangeRequestSchema.safeParse({
        ...request,
        targetIds: Array.from({ length: 501 }, (_, index) => `target-${index}`),
      }).success,
    ).toBe(false);
  });
});
