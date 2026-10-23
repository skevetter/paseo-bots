import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import contribute from "../index.server";
import { BotStateSchema } from "../shared/bot";
import { applyChanges } from "../shared/changes/apply";
import { SchedulePolicySchema } from "../shared/schedule-policy";
import { routinePreviewScheduleRpc } from "../shared/schedule-preview";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";

const policy = SchedulePolicySchema.parse({
  version: 1,
  timeZone: "America/New_York",
  gap: "skip",
  repeat: "both",
});
const context = { now: NOW, provider: "claude", providers: null };

function state() {
  return BotStateSchema.parse({ bots: [makeBot({ id: "bot-a", name: "Inbox" })] });
}

describe("schedule policy persistence", () => {
  it("saves an explicit policy for new routines without mutating a legacy routine during unrelated edits", () => {
    const created = applyChanges(
      state(),
      [
        {
          type: "add_routine",
          bot: "bot-a",
          name: "Morning",
          instructions: "Sort inbox",
          schedule: { type: "daily", time: "09:30", weekdays: [1, 2, 3, 4, 5] },
        },
      ],
      context,
    );
    const routine = defined(created.bots[0]?.routines[0]);
    expect(SchedulePolicySchema.parse(routine.schedulePolicy)).toEqual({
      version: 1,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      gap: "skip",
      repeat: "first",
    });
    const { schedulePolicy: _policy, ...legacy } = routine;
    const original = state();
    defined(original.bots[0]).routines = [legacy];
    const updated = applyChanges(
      original,
      [
        {
          type: "update_routine",
          bot: "bot-a",
          routine: legacy.id,
          name: "Renamed",
        },
      ],
      context,
    );
    expect(updated.bots[0]?.routines[0]?.schedulePolicy).toBeUndefined();
    const adopted = applyChanges(
      updated,
      [
        {
          type: "update_routine",
          bot: "bot-a",
          routine: legacy.id,
          schedulePolicy: policy,
        },
      ],
      context,
    );
    expect(adopted.bots[0]?.routines[0]?.schedulePolicy).toEqual(policy);
    expect(adopted.bots[0]?.routines[0]?.schedule).toEqual(legacy.schedule);
  });

  it("round-trips the caller's DST policy rather than replacing it with host defaults", () => {
    const saved = applyChanges(
      state(),
      [
        {
          type: "add_routine",
          bot: "bot-a",
          name: "Repeat",
          instructions: "Check",
          schedule: { type: "daily", time: "01:30" },
          schedulePolicy: policy,
        },
      ],
      context,
    );
    expect(
      BotStateSchema.parse(JSON.parse(JSON.stringify(saved))).bots[0]?.routines[0]?.schedulePolicy,
    ).toEqual(policy);
  });
});

function previewServer() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    handlers.set(contract.name, async (input) =>
      contract.output.parse(await handler(contract.input.parse(input), {} as PluginHandlerContext)),
    );
  };
  const stop = contribute({
    handle,
    on: () => () => {},
    registerSettings: () => ({
      read: async () => ({ status: "invalid" }),
      subscribe: () => () => {},
    }),
  } as unknown as PluginServerContext);
  return { stop, call: (input: unknown) => defined(handlers.get(routinePreviewScheduleRpc.name))(input) };
}

describe("registered schedule preview RPC", () => {
  useTempPaseoHome("paseo-bots-schedule-preview-");

  it("returns both repeated instants through the real handler without a host API", async () => {
    const server = previewServer();
    try {
      const result = await server.call({
        schedule: { kind: "daily", time: "01:30", weekdays: [0] },
        schedulePolicy: policy,
        since: "2026-10-31T00:00:00.000Z",
        after: "2026-11-01T04:00:00.000Z",
        count: 2,
      });
      const preview = routinePreviewScheduleRpc.output.parse(result);
      expect(preview.occurrences.map(({ at }) => at)).toEqual([
        "2026-11-01T05:30:00.000Z",
        "2026-11-01T06:30:00.000Z",
      ]);
      expect(preview.occurrences.map(({ localTime }) => localTime.match(/GMT-\d+/)?.[0])).toEqual([
        "GMT-4",
        "GMT-5",
      ]);
      expect(preview.legacyLocalTime).toBe(false);
    } finally {
      await server.stop();
    }
  });

  it("rejects unknown zones and invalid cron rather than returning an empty successful preview", async () => {
    const server = previewServer();
    const input = {
      schedule: { kind: "cron", expression: "0 9 * * *" },
      schedulePolicy: policy,
      since: NOW,
      after: NOW,
      count: 2,
    };
    try {
      await expect(
        server.call({ ...input, schedulePolicy: { ...policy, timeZone: "Not/A_Zone" } }),
      ).rejects.toThrow();
      await expect(
        server.call({ ...input, schedule: { kind: "cron", expression: "80 9 * * *" } }),
      ).rejects.toThrow();
    } finally {
      await server.stop();
    }
  });
});
