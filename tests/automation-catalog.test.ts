import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listAutomations } from "../server/automation-catalog";
import { BotsHost } from "../server/host";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import type { AutomationRow } from "../shared/automations";
import { BOT_LABEL, BotGroupSchema, type Routine } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import { ManagedRunSchema } from "../shared/managed-runs";
import { PolicySchema } from "../shared/policies";
import type { RoutineRun } from "../shared/rpc";
import { defined, makeBot, makeRun, NOW } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const AT = new Date("2026-10-23T10:15:00Z");

function routine(index: number): Routine {
  return {
    id: `opaque:routine/${index}`,
    name: "Shared name",
    prompt: `secret-prompt-${index}`,
    enabled: index % 2 === 0,
    schedule: { kind: "interval", minutes: 90 },
    resultsChatId: null,
    createdAt: "2026-10-23T10:00:00Z",
  };
}
interface Observed {
  id: string;
  status: string;
  botId: string;
  routineId: string;
  waiting: boolean;
}
async function fixture(count = 100, attached = true) {
  const directory = await mkdtemp(join(tmpdir(), "bots-automations-catalog-"));
  directories.push(directory);
  const store = new BotStore(join(directory, "state.json"));
  await store.update((values) => ({
    ...values,
    bots: Array.from({ length: count }, (_, index) =>
      makeBot({
        id: `opaque:bot/${index}`,
        name: "Same bot name",
        model: index === 99 ? "removed-model" : null,
        routines: [routine(index)],
      }),
    ),
    groups: [
      BotGroupSchema.parse({
        id: "team-odd",
        name: "Odd team",
        memberIds: Array.from({ length: count }, (_, index) => `opaque:bot/${index}`).filter(
          (_, index) => index % 2 === 1,
        ),
        createdAt: NOW,
        updatedAt: NOW,
      }),
    ],
  }));
  const host = new BotsHost(store);
  const runStore = new RunStore(join(directory, "routines.json"));
  const coordinator = { store: runStore, readiness: "waiting_for_host_api" as const };
  const observed: { agents: Observed[]; complete: boolean; reads: number } = {
    agents: [],
    complete: true,
    reads: 0,
  };
  const entries = structuredClone(LIVE_PROVIDERS);
  if (attached)
    host.attach({
      providers: { snapshot: async () => ({ entries }) },
      agents: {
        list: async () => {
          observed.reads++;
          return {
            pageInfo: { hasMore: !observed.complete },
            entries: observed.agents.map((agent) => ({
              agent: {
                id: agent.id,
                status: agent.status,
                archivedAt: null,
                labels: { [BOT_LABEL]: agent.botId, [ROUTINE_LABEL]: agent.routineId },
                pendingPermissions: agent.waiting ? [{ id: "permission" }] : [],
              },
            })),
          };
        },
      },
    } as never);
  return { store, host, coordinator, runStore, observed, entries };
}

async function saveRun(
  store: RunStore,
  index: number,
  status: RoutineRun["executionStatus"],
): Promise<RoutineRun> {
  const managed = ManagedRunSchema.parse({
    botId: `opaque:bot/${index}`,
    routineId: `opaque:routine/${index}`,
    requestId: `request-${index}`,
    artifact: { id: "a".repeat(64), sha256: "a".repeat(64) },
    provider: "claude",
    model: "opus",
    systemPromptHash: null,
    userPromptHash: null,
    environmentVersion: null,
    resourceIds: [],
    overlap: "queue",
    reservation: status === "unknown",
    notBefore: 0,
    attempts: [],
    timeline: null,
    creation: null,
    cancelRequested: false,
    coalescedInto: null,
  });
  const run = makeRun(`run-${index}`, {
    executionStatus: status,
    endedAt: status === "completed" ? NOW : null,
    managed,
  });
  await store.updateState((state) => {
    state.routines[`opaque:routine/${index}`] = { lastRunAt: null, runs: [run] };
    state.coordinator.occurrences[run.occurrenceKey] = run.id;
  });
  return run;
}

describe("all-bot server catalog", () => {
  it("paginates all 100 routines under opaque cursors without losing exact identities or leaking prompt content", async () => {
    const { host, coordinator, observed, store } = await fixture();
    const first = await listAutomations(host, coordinator, { limit: 17 }, AT);
    expect(observed.reads).toBe(1);
    expect(first.rows).toHaveLength(17);
    expect(first.readiness).toBe("waiting_for_host_api");
    const all = [...first.rows];
    let cursor = first.cursor;
    while (cursor !== null) {
      const page = await listAutomations(host, coordinator, { limit: 17, cursor }, AT);
      all.push(...page.rows);
      cursor = page.cursor;
    }
    expect(all.map((row) => row.botId).sort()).toEqual(
      Array.from({ length: 100 }, (_, index) => `opaque:bot/${index}`).sort(),
    );
    expect(new Set(all.map((row) => row.id)).size).toBe(100);
    expect(JSON.stringify(all)).not.toContain("secret-prompt");
    const prior = new Map(all.map((row) => [row.botId, row.id]));
    await store.update((values) => ({
      ...values,
      bots: [...values.bots].reverse().map((bot) => ({
        ...bot,
        name: "renamed bot",
        routines: bot.routines.map((entry) => ({ ...entry, name: "renamed routine" })),
      })),
    }));
    const renamed = await listAutomations(host, coordinator, { limit: 100 }, AT);
    expect(renamed.rows.every((row) => row.id === prior.get(row.botId))).toBe(true);
  });

  it("applies team, bot, selected-model and enabled filters before slicing a page", async () => {
    const { host, coordinator } = await fixture();
    const odd = await listAutomations(
      host,
      coordinator,
      { teamId: "team-odd", enabled: false, provider: "claude", model: "opus", limit: 1 },
      AT,
    );
    expect(odd.rows).toHaveLength(1);
    expect(odd.rows[0]?.teamId).toBe("team-odd");
    expect(odd.rows[0]?.enabled).toBe(false);
    expect(odd.cursor).not.toBeNull();
    const exact = await listAutomations(host, coordinator, { botId: "opaque:bot/98", limit: 1 }, AT);
    expect(exact.rows.map((row) => [row.botId, row.routineId, row.selectedModel])).toEqual([
      ["opaque:bot/98", "opaque:routine/98", "opus"],
    ]);
    expect(exact.cursor).toBeNull();
    expect(
      (await listAutomations(host, coordinator, { enabled: true, teamId: "team-odd", limit: 1 }, AT)).rows,
    ).toEqual([]);
  });
});

describe("catalog schedule and budget evidence", () => {
  it("reports prospective elapsed and zoned occurrences without migrating legacy schedules", async () => {
    const { host, coordinator, store } = await fixture(2);
    const before = await store.read();
    const initial = await listAutomations(host, coordinator, {}, AT);
    expect(
      initial.rows.every(
        (row) => row.schedule.elapsed && row.schedule.nextUtc === "2026-10-23T11:30:00.000Z",
      ),
    ).toBe(true);
    expect(await store.read()).toEqual(before);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot, index) => ({
        ...bot,
        routines: bot.routines.map((entry) => ({
          ...entry,
          schedule: { kind: "daily" as const, time: "01:30", weekdays: [0, 1, 2, 3, 4, 5, 6] },
          ...(index === 0
            ? {
                schedulePolicy: {
                  version: 1 as const,
                  timeZone: "America/New_York",
                  gap: "skip" as const,
                  repeat: "first" as const,
                },
              }
            : {}),
        })),
      })),
    }));
    const result = await listAutomations(host, coordinator, {}, new Date("2026-11-01T04:00:00Z"));
    const zoned = defined(result.rows.find((row) => row.botId === "opaque:bot/0"));
    expect(zoned.schedule).toMatchObject({
      nextUtc: "2026-11-01T05:30:00.000Z",
      timeZone: "America/New_York",
      legacyLocalTime: false,
      elapsed: false,
    });
    expect(zoned.schedule.nextLocal).toContain("01:30");
    const legacy = defined(result.rows.find((row) => row.botId === "opaque:bot/1"));
    expect(legacy.schedule.legacyLocalTime).toBe(true);
    expect(legacy.schedule.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(defined(defined((await store.read()).values.bots[1]).routines[0]).schedulePolicy).toBeUndefined();
  });

  it("shows configured budget values and provenance without reporting measured spend or enforced limits", async () => {
    const { host, coordinator, store } = await fixture(1);
    const snapshot = await store.read();
    const policy = PolicySchema.parse({
      id: "pol-budget",
      revision: 1,
      name: "Configured budget",
      createdAt: NOW,
      budget: { maxRunCostUsd: 4, maxRunTokens: 12000, maxRunSeconds: 300 },
    });
    await store.edit(snapshot.revision, (values) => ({
      ...values,
      policies: [policy],
      globalPolicy: { policyId: policy.id, revision: 1 },
    }));
    const row = defined((await listAutomations(host, coordinator, {}, AT)).rows[0]);
    expect(row.resolution.budget.maxRunCostUsd).toEqual({
      value: 4,
      source: { layer: "global", policyId: policy.id, revision: 1 },
    });
    expect(row.resolution.budget.maxRunTokens.value).toBe(12000);
    expect(row.resolution.budget.maxRunSeconds.value).toBe(300);
    expect(row.spendUsd).toBeNull();
    expect(row.attention.budget_exhaustion.value).toBeNull();
    expect(row.unavailable).toContain(
      "Resolved limits are configuration metadata, not proof of enforced dollar/token limits.",
    );
  });
});

describe("opaque routine ownership", () => {
  it("keeps managed last state and schedule anchors separate for bots sharing a routine ID", async () => {
    const { host, coordinator, store, runStore } = await fixture(2);
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({
        ...bot,
        routines: bot.routines.map((entry) => ({ ...entry, id: "shared-routine" })),
      })),
    }));
    const first = await saveRun(runStore, 0, "completed");
    const second = await saveRun(runStore, 1, "failed");
    const a: RoutineRun = {
      ...first,
      trigger: "schedule",
      scheduledFor: "2026-10-23T10:00:00Z",
      managed: { ...defined(first.managed), routineId: "shared-routine" },
    };
    const b: RoutineRun = {
      ...second,
      trigger: "schedule",
      scheduledFor: "2026-10-23T12:00:00Z",
      managed: { ...defined(second.managed), routineId: "shared-routine" },
    };
    await runStore.updateState((state) => {
      state.routines = { "shared-routine": { lastRunAt: b.scheduledFor, runs: [a, b] } };
      state.coordinator.occurrences = { [a.occurrenceKey]: a.id, [b.occurrenceKey]: b.id };
    });
    const result = await listAutomations(host, coordinator, {}, new Date("2026-10-23T12:15:00Z"));
    const rowA = defined(result.rows.find((row) => row.botId === "opaque:bot/0"));
    const rowB = defined(result.rows.find((row) => row.botId === "opaque:bot/1"));
    expect(rowA.id).not.toBe(rowB.id);
    expect(rowA.lastRunId).toBe(a.id);
    expect(rowB.lastRunId).toBe(b.id);
    expect(rowA.schedule.nextUtc).toBe("2026-10-23T12:15:00.000Z");
    expect(rowB.schedule.nextUtc).toBe("2026-10-23T13:30:00.000Z");
  });
});

describe("complete census ownership", () => {
  it("cannot establish unique ownership from one visible agent in an incomplete census", async () => {
    const { host, coordinator, observed } = await fixture(1);
    observed.complete = false;
    observed.agents.push({
      id: "visible-A",
      botId: "opaque:bot/0",
      routineId: "opaque:routine/0",
      status: "running",
      waiting: true,
    });
    const partial = defined((await listAutomations(host, coordinator, {}, AT)).rows[0]);
    expect(partial.attention.permission_requests.value).toBe(true);
    expect(partial.owner).toBeNull();
    observed.complete = true;
    const complete = defined((await listAutomations(host, coordinator, {}, AT)).rows[0]);
    expect(complete.owner).toEqual({ agentId: "visible-A", status: "running" });
  });
});

describe("evidence-backed attention", () => {
  it("uses durable append order for last state when distinct runs share a timestamp", async () => {
    const { host, coordinator, runStore } = await fixture(1);
    const first = makeRun("first-at-same-time", { startedAt: AT.toISOString(), endedAt: AT.toISOString() });
    const last = makeRun("last-at-same-time", {
      startedAt: AT.toISOString(),
      endedAt: AT.toISOString(),
      executionStatus: "failed",
    });
    await runStore.updateState((state) => {
      state.routines["opaque:routine/0"] = { lastRunAt: null, runs: [first, last] };
      state.coordinator.occurrences[first.occurrenceKey] = first.id;
      state.coordinator.occurrences[last.occurrenceKey] = last.id;
    });
    const row = defined((await listAutomations(host, coordinator, {}, AT)).rows[0]);
    expect(row.lastRunId).toBe(last.id);
    expect(row.lastExecutionStatus).toBe("failed");
  });
  it("filters real permission waits, unknown outcomes and removed models, never unavailable producer fields", async () => {
    const { host, coordinator, runStore, observed } = await fixture();
    await saveRun(runStore, 96, "completed");
    await saveRun(runStore, 98, "waiting_for_user");
    await saveRun(runStore, 99, "unknown");
    observed.agents.push({
      id: "observed-agent-98",
      botId: "opaque:bot/98",
      routineId: "opaque:routine/98",
      status: "running",
      waiting: true,
    });
    const permissions = await listAutomations(
      host,
      coordinator,
      { attention: "permission_requests", limit: 1 },
      AT,
    );
    expect(permissions.rows.map((row) => row.botId)).toEqual(["opaque:bot/98"]);
    expect(permissions.rows[0]?.owner).toEqual({ agentId: "observed-agent-98", status: "running" });
    expect(permissions.rows[0]?.active).toEqual({ count: 1, waiting: 1, unknown: 0, source: "run_ledger" });
    const unknown = await listAutomations(host, coordinator, { attention: "unknown_outcomes" }, AT);
    expect(unknown.rows.map((row) => row.botId).sort()).toEqual(["opaque:bot/96", "opaque:bot/99"]);
    expect(defined(unknown.rows.find((row) => row.botId === "opaque:bot/96"))).toMatchObject({
      lastExecutionStatus: "completed",
      lastTaskOutcome: "unknown",
    });
    expect(defined(unknown.rows.find((row) => row.botId === "opaque:bot/99")).active.unknown).toBe(1);
    expect(
      (await listAutomations(host, coordinator, { attention: "stale_models" }, AT)).rows.map(
        (row) => row.botId,
      ),
    ).toEqual(["opaque:bot/99"]);
    for (const attention of ["memory_failure", "budget_exhaustion"] as const)
      expect((await listAutomations(host, coordinator, { attention }, AT)).rows).toEqual([]);
    expect(permissions.rows[0]?.attention.memory_failure.value).toBeNull();
    expect(permissions.rows[0]?.attention.budget_exhaustion.value).toBeNull();
    expect(permissions.rows[0]?.spendUsd).toBeNull();
    expect(permissions.rows[0]?.escalationCount).toBeNull();
  });

  it("does not call absent or partial host evidence healthy or fabricate a unique owner", async () => {
    const disconnected = await fixture(1, false);
    const row = defined((await listAutomations(disconnected.host, disconnected.coordinator, {}, AT)).rows[0]);
    expect(row.attention.permission_requests.value).toBeNull();
    expect(row.attention.stale_models.value).toBeNull();
    expect(row.attention.unknown_outcomes.value).toBeNull();
    expect(row.owner).toBeNull();
    const { host, coordinator, observed } = await fixture(1);
    observed.complete = false;
    expect(
      (await listAutomations(host, coordinator, {}, AT)).rows[0]?.attention.permission_requests.value,
    ).toBeNull();
    observed.agents.push(
      { id: "one", botId: "opaque:bot/0", routineId: "opaque:routine/0", status: "running", waiting: true },
      { id: "two", botId: "opaque:bot/0", routineId: "opaque:routine/0", status: "running", waiting: false },
    );
    const multiple = defined((await listAutomations(host, coordinator, {}, AT)).rows[0]);
    expect(multiple.attention.permission_requests.value).toBe(true);
    expect(multiple.owner).toBeNull();
  });
});

describe("opaque catalog cursor conflicts", () => {
  it("refuses malformed, changed-filter and changed-revision cursors with reload-first-page errors", async () => {
    const { host, coordinator, store } = await fixture();
    const first = await listAutomations(host, coordinator, { limit: 1 }, AT);
    const cursor = defined(first.cursor);
    await expect(
      listAutomations(host, coordinator, { cursor: "not-a-cursor", limit: 1 }, AT),
    ).rejects.toThrow("Reload the first page");
    await expect(
      listAutomations(host, coordinator, { cursor, enabled: false, limit: 1 }, AT),
    ).rejects.toThrow("Reload the first page");
    await store.update((values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, title: "later revision" })),
    }));
    await expect(listAutomations(host, coordinator, { cursor, limit: 1 }, AT)).rejects.toThrow(
      "Reload the first page",
    );
  });

  it("rejects a cursor whose last attention row left the result instead of skipping or repeating work", async () => {
    const { host, coordinator, observed } = await fixture(2);
    observed.agents.push(
      { id: "one", botId: "opaque:bot/0", routineId: "opaque:routine/0", status: "running", waiting: true },
      { id: "two", botId: "opaque:bot/1", routineId: "opaque:routine/1", status: "running", waiting: true },
    );
    const first = await listAutomations(
      host,
      coordinator,
      { attention: "permission_requests", limit: 1 },
      AT,
    );
    const row: AutomationRow = defined(first.rows[0]);
    const agent = defined(observed.agents.find((entry) => entry.botId === row.botId));
    agent.waiting = false;
    await expect(
      listAutomations(
        host,
        coordinator,
        { attention: "permission_requests", limit: 1, cursor: defined(first.cursor) },
        AT,
      ),
    ).rejects.toThrow("Reload the first page");
  });
});
