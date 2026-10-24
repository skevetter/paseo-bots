import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { BOTS_TOOLS } from "../server/control/tools/bots";
import { ROUTINE_TOOLS } from "../server/control/tools/routines";
import { exportBot, importBot } from "../server/share";
import { BotSchema, type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { duplicateOf } from "../shared/bot-copy";
import { applyChanges } from "../shared/changes/apply";
import { ChangeSchema, ChangesSchema } from "../shared/changes/schema";
import { startControl } from "./control-helpers";
import { defined, makeBot, NOW, useTempPaseoHome } from "./helpers";

const context = { now: NOW, provider: "claude" };
const running: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

describe("explicit execution adoption", () => {
  it("creates and updates managed execution only when explicitly requested", () => {
    const state: BotState = { bots: [], history: [] };
    const created = applyChanges(
      state,
      ChangesSchema.parse([
        { type: "create_bot", name: "Existing behavior" },
        { type: "create_bot", name: "Managed", execution_mode: "managed" },
      ]),
      context,
    );
    expect(created.bots.map((bot) => bot.executionMode ?? "legacy")).toEqual(["legacy", "managed"]);
    const managed = defined(created.bots[1], "managed bot");
    const edited = applyChanges(
      created,
      ChangesSchema.parse([
        { type: "update_bot", bot: managed.id, title: "Still managed" },
        { type: "update_bot", bot: managed.id, execution_mode: "legacy" },
      ]),
      context,
    );
    expect(edited.bots[1]).toMatchObject({ title: "Still managed", executionMode: "legacy" });
    expect(created.bots[1]?.executionMode).toBe("managed");
  });

  it("refuses remote managed execution both at state validation and change application", () => {
    const remote = makeBot({ hostId: "other-host", executionMode: "legacy" });
    const state = { bots: [remote], history: [] };
    expect(BotSchema.safeParse({ ...remote, executionMode: "managed" }).success).toBe(false);
    expect(() =>
      applyChanges(
        state,
        ChangesSchema.parse([{ type: "update_bot", bot: remote.id, execution_mode: "managed" }]),
        context,
      ),
    ).toThrow("another host");
    expect(state.bots[0]?.executionMode).toBe("legacy");
  });
});

describe("routine deadline producers", () => {
  it("preserves overlap and resource restrictions while changing the due-relative deadline", () => {
    const created = applyChanges(
      { bots: [makeBot()], history: [] },
      ChangesSchema.parse([
        {
          type: "add_routine",
          bot: "bot-1",
          name: "Check",
          instructions: "Inspect.",
          schedule: { type: "webhook" },
          deadline_seconds: 30,
        },
      ]),
      context,
    );
    const bot = defined(created.bots[0], "bot");
    const routine = defined(bot.routines[0], "routine");
    expect(routine.runtime?.deadlineSeconds).toBe(30);
    routine.runtime = {
      ...routine.runtime,
      overlap: "queue",
      resourceIds: ["opaque-resource"],
      capacity: { perBot: 1 },
    };
    const edited = applyChanges(
      created,
      ChangesSchema.parse([
        { type: "update_routine", bot: bot.id, routine: routine.id, deadline_seconds: 90 },
        { type: "update_routine", bot: bot.id, routine: routine.id, name: "Renamed" },
      ]),
      context,
    );
    expect(edited.bots[0]?.routines[0]).toMatchObject({
      name: "Renamed",
      runtime: {
        deadlineSeconds: 90,
        overlap: "queue",
        resourceIds: ["opaque-resource"],
        capacity: { perBot: 1 },
      },
    });
  });

  it.each([0, -1, 0.5, Infinity])(
    "refuses a deadline of %s seconds before storing a routine",
    (deadline_seconds) => {
      expect(
        ChangeSchema.safeParse({
          type: "add_routine",
          bot: "bot-1",
          name: "Check",
          instructions: "Inspect.",
          schedule: { type: "webhook" },
          deadline_seconds,
        }).success,
      ).toBe(false);
      expect(
        ChangeSchema.safeParse({
          type: "update_routine",
          bot: "bot-1",
          routine: "rt-1",
          deadline_seconds,
        }).success,
      ).toBe(false);
    },
  );
});

describe("portable execution adoption", () => {
  useTempPaseoHome("paseo-bots-execution-import-");

  it("never enables managed execution by importing or duplicating a managed source", async () => {
    const source = makeBot({ executionMode: "managed" });
    const { json } = await exportBot({ bot: source, includeMemory: false }, EMPTY_LIBRARY);
    const payload = JSON.parse(json);
    payload.bot.executionMode = "managed";
    const imported = await importBot({ botId: "imported", json: JSON.stringify(payload) });
    expect(imported.bot.executionMode).toBe("legacy");
    const copy = duplicateOf(source, { ...imported.bot, executionMode: "managed" });
    expect(copy.executionMode).toBe("legacy");
    expect(copy.id).toBe("imported");
  });
});

describe("execution configuration over control HTTP", () => {
  useTempPaseoHome("paseo-bots-execution-control-");
  beforeEach(async () => {
    await rm(join(pluginDataPath(), "routines.json"), { force: true });
  });

  it("persists explicit execution_mode and rejects remote adoption", async () => {
    const remote = makeBot({ id: "remote", name: "Remote", hostId: "other-host", executionMode: "legacy" });
    const control = await startControl(BOTS_TOOLS, { bots: [remote] });
    running.push(control);
    const created = await control.call("bots_create", { name: "Managed", execution_mode: "managed" });
    expect(created.isError).toBe(false);
    expect(created.data.bot).toMatchObject({ executionMode: "managed" });
    const bot = defined(
      (await control.store.read()).values.bots.find((entry) => entry.name === "Managed"),
      "created bot",
    );
    expect(bot.executionMode).toBe("managed");
    const legacy = await control.call("bots_update", { bot: bot.id, execution_mode: "legacy" });
    expect(legacy.isError).toBe(false);
    expect((await control.store.read()).values.bots.find((entry) => entry.id === bot.id)?.executionMode).toBe(
      "legacy",
    );
    expect((await control.call("bots_update", { bot: "remote", execution_mode: "managed" })).isError).toBe(
      true,
    );
    expect(
      (await control.store.read()).values.bots.find((entry) => entry.id === "remote")?.executionMode,
    ).toBe("legacy");
  });

  it("carries deadline_seconds through routine control changes into durable bot state", async () => {
    const control = await startControl(ROUTINE_TOOLS, { bots: [makeBot({ executionMode: "managed" })] });
    running.push(control);
    const created = await control.call("routines_create", {
      bot: "bot-1",
      name: "Check",
      instructions: "Inspect.",
      schedule: { type: "webhook" },
      deadline_seconds: 45,
    });
    expect(created.isError).toBe(false);
    expect((await control.store.read()).values.bots[0]?.routines[0]?.runtime?.deadlineSeconds).toBe(45);
    const updated = await control.call("routines_update", {
      bot: "bot-1",
      routine: "Check",
      deadline_seconds: 75,
    });
    expect(updated.isError).toBe(false);
    expect((await control.store.read()).values.bots[0]?.routines[0]?.runtime?.deadlineSeconds).toBe(75);
  });
});
