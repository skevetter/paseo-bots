import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlContext } from "../server/control/tool";
import { FLEET_TOOLS } from "../server/control/tools/fleet";
import { applyFleetChange, listFleet, previewFleetChange, revertFleetChange } from "../server/fleet";
import { BotsHost } from "../server/host";
import { BotStore } from "../server/state";
import { type Bot, BotStateSchema } from "../shared/bot";
import { providerInfo } from "../shared/changes/context";
import { MAX_RECEIPTS } from "../shared/changes/receipt";
import { type FleetChangeRequest, FleetChangeRequestSchema, type FleetPreview } from "../shared/fleet";
import { PolicySchema, resolveBot } from "../shared/policies";
import { defined, makeBot, makeRun, NOW } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(bots: Bot[] = [makeBot()]) {
  const directory = await mkdtemp(join(tmpdir(), "bots-fleet-"));
  directories.push(directory);
  const store = new BotStore(join(directory, "state.json"));
  await store.update((values) => ({ ...values, bots }));
  const host = new BotsHost(store);
  const entries = structuredClone(LIVE_PROVIDERS);
  const list = vi.fn(async () => ({ entries: [], pageInfo: { hasMore: false } }));
  const mutate = vi.fn(() => {
    throw new Error("Fleet must not mutate a host agent.");
  });
  host.attach({
    providers: { snapshot: async () => ({ entries }) },
    agents: { list, ref: mutate, create: mutate },
  } as never);
  return { store, host, entries, list, mutate };
}

async function requestFor(
  store: BotStore,
  patch: Partial<FleetChangeRequest> = {},
): Promise<FleetChangeRequest> {
  const snapshot = await store.read();
  return {
    operationId: "fleet-change-1",
    revision: snapshot.revision,
    botIds: snapshot.values.bots.map((bot) => bot.id),
    patch: { model: "opus" },
    unset: [],
    ...patch,
  };
}

async function preview(host: BotsHost, request: FleetChangeRequest): Promise<FleetPreview> {
  const result = await previewFleetChange(host, request);
  if (result.status !== "previewed") throw new Error(result.error);
  return result.preview;
}

async function apply(host: BotsHost, request: FleetChangeRequest) {
  const shown = await preview(host, request);
  return applyFleetChange(host, { request, previewDigest: shown.digest });
}

const policy = PolicySchema.parse({
  id: "pol-shared",
  revision: 1,
  name: "Shared",
  roles: { executor: { provider: "claude", model: "opus" } },
  createdAt: NOW,
});

describe("atomic fleet configuration", () => {
  it("commits 100 bots and their revision pair together, then reopens and replays after another write", async () => {
    const { store, host, mutate } = await fixture(
      Array.from({ length: 100 }, (_, index) => makeBot({ id: `bot-${index}`, alwaysAllow: ["files/read"] })),
    );
    const request = await requestFor(store);
    const shown = await preview(host, request);
    const writes: number[] = [];
    store.onChange((snapshot) =>
      writes.push(snapshot.values.bots.filter((bot) => bot.model === "opus").length),
    );
    const result = await applyFleetChange(host, { request, previewDigest: shown.digest });
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    expect(writes).toEqual([100]);
    expect(result.receipt).toMatchObject({
      originalRevision: request.revision,
      newRevision: result.revision,
    });
    const reopened = new BotStore(store.path);
    expect(await reopened.read()).toEqual(await store.read());
    expect(JSON.parse(await readFile(store.path, "utf8")).values.receipts[0]).toEqual(result.receipt);
    const later = await reopened.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, title: "Later unrelated edit" })),
    }));
    const replay = await applyFleetChange(new BotsHost(reopened), { request, previewDigest: shown.digest });
    expect(replay).toEqual({ status: "replayed", receipt: result.receipt, revision: later.revision });
    expect(
      (await reopened.read()).values.bots.every(
        (bot) => bot.title === "Later unrelated edit" && bot.alwaysAllow[0] === "files/read",
      ),
    ).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("rejects a reused operation id with changed request or digest before stale revision handling", async () => {
    const { store, host } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    expect((await applyFleetChange(host, { request, previewDigest: shown.digest })).status).toBe("applied");
    const result = await applyFleetChange(host, {
      request: { ...request, patch: { model: null } },
      previewDigest: shown.digest,
    });
    expect(result).toMatchObject({ status: "conflict", error: expect.stringContaining("different content") });
    expect(await applyFleetChange(host, { request, previewDigest: "different" })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("different content"),
    });
  });
});

describe("fleet preview conflicts", () => {
  it("rejects stale previews and tampered digests without changing any bot", async () => {
    const { store, host } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    const original = await store.read();
    expect((await applyFleetChange(host, { request, previewDigest: `${shown.digest}x` })).status).toBe(
      "conflict",
    );
    expect(await store.read()).toEqual(original);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, title: "external" })),
    }));
    const later = await store.read();
    expect(await applyFleetChange(host, { request, previewDigest: shown.digest })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("changed elsewhere"),
    });
    expect(await store.read()).toEqual(later);
  });

  it("binds provider evidence even when its changed fact leaves the target compatible", async () => {
    const { store, host, entries } = await fixture();
    const request = await requestFor(store);
    const shown = await preview(host, request);
    defined(entries[0]).models[0] = { id: "opus", label: "Updated host evidence", isDefault: true };
    expect((await preview(host, request)).compatible).toBe(true);
    expect(await applyFleetChange(host, { request, previewDigest: shown.digest })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("host evidence"),
    });
    expect((await store.read()).revision).toBe(request.revision);
  });

  it("rechecks host facts after entering the authoritative writer queue", async () => {
    const { store, host, entries } = await fixture();
    const operation = { id: "queue-holder", kind: "test", bodyHash: "same", at: NOW };
    await store.apply(operation, (values) => ({ values }));
    const request = await requestFor(store);
    const shown = await preview(host, request);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = store.reconcileOperation(operation, async () => {
      await gate;
    });
    const result = applyFleetChange(host, { request, previewDigest: shown.digest });
    defined(entries[0]).models[0] = { id: "opus", label: "Changed while queued", isDefault: true };
    release();
    await held;
    expect(await result).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("host evidence"),
    });
    expect((await store.read()).values.bots[0]?.model).toBeNull();
  });
});

describe("fleet targets and inheritance", () => {
  it("admits exactly 500 unique IDs and rejects 501, duplicates, missing IDs and permission fields", async () => {
    const { store, host } = await fixture(
      Array.from({ length: 500 }, (_, index) => makeBot({ id: `bot-${index}` })),
    );
    const request = await requestFor(store);
    expect((await preview(host, request)).rows.map((row) => row.botId)).toEqual(request.botIds);
    expect(
      FleetChangeRequestSchema.safeParse({ ...request, botIds: [...request.botIds, "one-too-many"] }).success,
    ).toBe(false);
    expect(FleetChangeRequestSchema.safeParse({ ...request, botIds: ["bot-0", "bot-0"] }).success).toBe(
      false,
    );
    expect(
      FleetChangeRequestSchema.safeParse({ ...request, patch: { modeId: "bypassPermissions" } }).success,
    ).toBe(false);
    expect(
      FleetChangeRequestSchema.safeParse({ ...request, patch: { model: "opus" }, unset: ["provider"] })
        .success,
    ).toBe(false);
    expect(await previewFleetChange(host, { ...request, botIds: ["bot-0", "missing"] })).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("missing"),
    });
    expect((await store.read()).revision).toBe(request.revision);
  });

  it.each([
    { patch: { model: "missing" }, field: "model" },
    { patch: { thinkingOptionId: "missing" }, field: "thinkingOptionId" },
  ])("rejects invalid effective $field without touching the fleet", async ({ patch, field }) => {
    const { store, host } = await fixture();
    const request = await requestFor(store, { patch });
    const shown = await preview(host, request);
    expect(shown.rows[0]?.incompatibilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ field })]),
    );
    expect((await applyFleetChange(host, { request, previewDigest: shown.digest })).status).toBe("conflict");
    expect((await store.read()).revision).toBe(request.revision);
  });

  it("resets dependent overrides to inherited and unbinds only the bot policy", async () => {
    const { store, host } = await fixture([
      makeBot({
        model: "old",
        thinkingOptionId: "old",
        policy: { binding: { policyId: policy.id, revision: 1 }, inherit: [] },
      }),
    ]);
    const start = await store.read();
    await store.edit(start.revision, (values) => ({
      ...values,
      policies: [policy],
      globalPolicy: { policyId: policy.id, revision: 1 },
    }));
    const request = await requestFor(store, { patch: { binding: null }, unset: ["provider"] });
    const shown = await preview(host, request);
    expect(shown.rows[0]?.afterResolution.model).toMatchObject({
      value: "opus",
      source: { layer: "global" },
    });
    expect((await apply(host, request)).status).toBe("applied");
    expect((await store.read()).values.bots[0]?.policy).toEqual({
      binding: null,
      inherit: ["provider", "model", "thinkingOptionId"],
    });
  });
});

describe("fleet permission boundary", () => {
  it("preserves the approval class and explicit grants on a compatible provider change", async () => {
    const before = makeBot({ modeId: "default", alwaysAllow: ["files/read"], contactBots: "allow" });
    const { store, host, entries, mutate } = await fixture([before]);
    entries.push({ ...defined(entries[0]), provider: "codex" });
    const request = await requestFor(store, { patch: { provider: "codex" } });
    expect((await apply(host, request)).status).toBe("applied");
    const after = defined((await store.read()).values.bots[0]);
    expect(after).toEqual({ ...before, provider: "codex", updatedAt: after.updatedAt });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("compares the effective BEFORE provider rather than trusting the already-edited bot resolver", async () => {
    const { store, host, entries } = await fixture([makeBot({ modeId: null })]);
    const request = await requestFor(store, { patch: { provider: "omp" } });
    const shown = await preview(host, request);
    expect(
      resolveBot((await store.read()).values, defined(shown.rows[0]).after, {
        providers: providerInfo(entries),
      }).ok,
    ).toBe(true);
    expect(shown.rows[0]?.incompatibilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "approval_changed", field: "modeId" })]),
    );
    expect((await applyFleetChange(host, { request, previewDigest: shown.digest })).status).toBe("conflict");
    expect((await store.read()).values.bots[0]?.provider).toBe("claude");
  });

  it.each([
    { modeId: "default", alwaysAllow: [], expected: "mode_not_on_provider" },
    { modeId: null, alwaysAllow: ["files/read"], expected: "grants_not_preserved" },
  ])("refuses all bots when a target loses $expected", async ({ modeId, alwaysAllow, expected }) => {
    const { store, host, entries } = await fixture([
      makeBot({ modeId, alwaysAllow }),
      makeBot({ id: "bot-2" }),
    ]);
    const source = defined(entries[0]);
    entries.push({
      ...source,
      provider: "clone",
      modes: [{ id: "auto", label: "Auto", colorTier: "moderate" }],
    });
    const request = await requestFor(store, { patch: { provider: "clone" } });
    const shown = await preview(host, request);
    expect(shown.rows[0]?.incompatibilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: expected })]),
    );
    expect((await applyFleetChange(host, { request, previewDigest: shown.digest })).status).toBe("conflict");
    expect((await store.read()).revision).toBe(request.revision);
  });

  it("does not let MCP bypass approval for an effective provider switch", async () => {
    const { store, host, entries } = await fixture();
    entries.push({ ...defined(entries[0]), provider: "clone" });
    const request = await requestFor(store, { patch: { provider: "clone" } });
    const shown = await preview(host, request);
    expect(shown.compatible).toBe(true);
    const tool = defined(FLEET_TOOLS.find((item) => item.name === "fleet_apply_change"));
    const context = { host, settings: async () => ({ allowElevated: false }) } as unknown as ControlContext;
    const denied = await tool.run(tool.input.parse({ request, previewDigest: shown.digest }), context);
    expect(denied).toMatchObject({
      data: { status: "conflict", error: expect.stringContaining("Apply this change in Paseo") },
    });
    expect((await store.read()).revision).toBe(request.revision);
    context.settings = async () => ({ externalControl: true, allowElevated: true });
    const allowed = await tool.run(tool.input.parse({ request, previewDigest: shown.digest }), context);
    expect(allowed).toMatchObject({ data: { status: "applied" } });
  });
});

describe("fleet revert and receipt retention", () => {
  it("audits revert as a new transition, preserving unrelated changes and replaying its receipt", async () => {
    const { store, host } = await fixture([makeBot(), makeBot({ id: "unrelated" })]);
    const request = await requestFor(store, { botIds: ["bot-1"] });
    expect((await apply(host, request)).status).toBe("applied");
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => (bot.id === "unrelated" ? { ...bot, soul: "keep me" } : bot)),
    }));
    const body = {
      operationId: "fleet-revert-1",
      revision: (await store.read()).revision,
      appliedOperationId: request.operationId,
    };
    const reverted = await revertFleetChange(host, body);
    if (reverted.status !== "applied") throw new Error(JSON.stringify(reverted));
    expect(reverted.receipt).toMatchObject({
      kind: "fleet.revert",
      originalRevision: body.revision,
      newRevision: reverted.revision,
    });
    const saved = await store.read();
    expect(saved.values.bots[0]?.model).toBeNull();
    expect(saved.values.bots[0]?.policy).toBeUndefined();
    expect(saved.values.bots[1]?.soul).toBe("keep me");
    expect((await revertFleetChange(host, body)).status).toBe("replayed");
    expect(await new BotStore(store.path).read()).toEqual(saved);
  });

  it("conflicts on any later affected-bot edit, including non-execution fields", async () => {
    const { store, host } = await fixture();
    const request = await requestFor(store);
    expect((await apply(host, request)).status).toBe("applied");
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, soul: "later edit" })),
    }));
    const before = await store.read();
    expect(
      await revertFleetChange(host, {
        operationId: "revert-conflict",
        revision: before.revision,
        appliedOperationId: request.operationId,
      }),
    ).toMatchObject({ status: "conflict", error: expect.stringContaining("changed after") });
    expect(await store.read()).toEqual(before);
  });

  it("keeps revision identity consistent through pin release, replay and receipt eviction", async () => {
    const { store, host } = await fixture();
    const pending = { id: "pending-effect", kind: "test", bodyHash: "same", at: NOW, pending: true };
    await store.apply(pending, (values) => ({ values }));
    const request = await requestFor(store);
    const result = await apply(host, request);
    if (result.status !== "applied") throw new Error(JSON.stringify(result));
    await store.completeOperation(pending);
    expect(await new BotStore(store.path).read()).toEqual(await store.read());
    for (let index = 0; index < MAX_RECEIPTS; index++)
      await store.apply({ id: `retained-${index}`, kind: "test", bodyHash: "same", at: NOW }, (values) => ({
        values,
      }));
    const current = await store.read();
    expect(current.values.receipts?.some((receipt) => receipt.operationId === request.operationId)).toBe(
      false,
    );
    expect(await new BotStore(store.path).read()).toEqual(current);
    expect(result.receipt.newRevision).not.toBe(current.revision);
  });

  it("refuses capacity pressure rather than dropping unresolved effects and opens metadata-free v2", async () => {
    const { store, host } = await fixture();
    const values = (await store.read()).values;
    values.receipts = Array.from({ length: MAX_RECEIPTS }, (_, index) => ({
      operationId: `pending-${index}`,
      kind: "test",
      bodyHash: "hash",
      appliedAt: NOW,
      created: [],
      createdCount: 0,
      notes: [],
    }));
    values.pendingOperations = values.receipts.map((receipt) => receipt.operationId);
    await writeFile(store.path, JSON.stringify({ version: 2, values }));
    expect(BotStateSchema.parse((await new BotStore(store.path).read()).values)).toEqual(values);
    const request = await requestFor(store);
    expect(await apply(host, request)).toMatchObject({
      status: "conflict",
      error: expect.stringContaining("unresolved"),
    });
    expect((await store.read()).values.pendingOperations).toEqual(values.pendingOperations);
  });
});

describe("fleet observability without usage aggregation", () => {
  it("uses one agent snapshot, counts active work, retains task outcomes, and never sums spend", async () => {
    const bot = makeBot({
      routines: [
        {
          id: "rt-1",
          name: "Run",
          prompt: "go",
          schedule: { kind: "webhook" },
          enabled: true,
          resultsChatId: null,
          createdAt: NOW,
        },
      ],
    });
    const { host, list, mutate } = await fixture([bot, makeBot({ id: "bot-2" })]);
    list.mockResolvedValue({
      entries: [
        {
          agent: {
            labels: { "paseo-bots.bot": "bot-1" },
            status: "running",
            archivedAt: null,
            lastUsage: { costUsd: 9 },
          },
        },
        { agent: { labels: { "paseo-bots.bot": "bot-1" }, status: "initializing", archivedAt: null } },
        { agent: { labels: { "paseo-bots.bot": "bot-1" }, status: "idle", archivedAt: null } },
      ],
      pageInfo: { hasMore: false },
    } as never);
    const result = await listFleet(host, {
      "rt-1": { lastRunAt: NOW, runs: [makeRun("latest", { taskOutcome: "needs_review" })] },
    });
    expect(result.rows.map((row) => [row.activeWork, row.spendUsd, row.lastOutcome])).toEqual([
      [2, null, "needs_review"],
      [0, null, "unknown"],
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
  });

  it("reports unknown active work for unavailable and partial host snapshots", async () => {
    const { store, host, list } = await fixture();
    const offline = await listFleet(new BotsHost(store));
    expect(offline.rows[0]).toMatchObject({
      activeWork: null,
      spendUsd: null,
      attention: expect.arrayContaining([expect.stringContaining("Active work unavailable")]),
    });
    list.mockResolvedValue({ entries: [], pageInfo: { hasMore: true } });
    expect((await listFleet(host)).rows[0]?.activeWork).toBeNull();
    list.mockRejectedValue(new Error("unreachable"));
    expect((await listFleet(host)).rows[0]?.activeWork).toBeNull();
  });
});
