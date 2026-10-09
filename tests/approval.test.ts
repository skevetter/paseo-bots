import { describe, expect, it } from "vitest";
import { exportTeam, importTeam } from "../server/share";
import { startingMode } from "../shared/approval";
import {
  type Approval,
  type Bot,
  type BotDefaults,
  type BotState,
  DEFAULT_BOT_DEFAULTS,
  EMPTY_LIBRARY,
} from "../shared/bot";
import { elevations, importElevations } from "../shared/elevated";
import { applyDefaults, presetFromBot } from "../shared/presets";
import { BOT_TEMPLATES, botFromPreset, newBot } from "../shared/templates";
import { defined, makeBot, useTempPaseoHome } from "./helpers";
import { LIVE_MODES } from "./provider-modes";

const defaults = (patch: Partial<BotDefaults> = {}): BotDefaults => ({ ...DEFAULT_BOT_DEFAULTS, ...patch });
const modeFor = (approval: Approval, provider: string) =>
  startingMode(defaults({ approval }), provider, LIVE_MODES[provider]);

describe("approval mode for new bots", () => {
  it.each([
    ["claude", "provider", null],
    ["claude", "ask", "default"],
    ["claude", "unattended", "bypassPermissions"],
    ["omp", "provider", null],
    ["omp", "ask", "ask"],
    ["omp", "unattended", "full"],
    ["hermes", "provider", null],
    ["hermes", "ask", "default"],
    ["hermes", "unattended", "dont_ask"],
  ] as const)("starts %s bots on %s approval in %s", (provider, approval, modeId) => {
    expect(modeFor(approval, provider)).toEqual({ modeId, note: null });
  });

  it("lets a provider's own mode win over the approval setting", () => {
    const chosen = defaults({ approval: "unattended", modeByProvider: { claude: "acceptEdits" } });
    expect(startingMode(chosen, "claude", LIVE_MODES.claude).modeId).toBe("acceptEdits");
    expect(startingMode(chosen, "omp", LIVE_MODES.omp).modeId).toBe("full");
    expect(startingMode(chosen, "codex", undefined).modeId).toBeNull();
  });

  it("falls back to the provider's default mode and says why", () => {
    const strict = { modes: [{ id: "default", colorTier: "safe" }], defaultModeId: "default" };
    expect(startingMode(defaults({ approval: "unattended" }), "strict", strict)).toEqual({
      modeId: null,
      note: "strict has no mode that runs without asking, so it starts in the default mode.",
    });
    const gone = defaults({ modeByProvider: { claude: "yolo" } });
    expect(startingMode(gone, "claude", LIVE_MODES.claude)).toEqual({
      modeId: null,
      note: 'claude has no mode "yolo", so it starts in the default mode.',
    });
    expect(startingMode(defaults({ approval: "ask" }), "claude", undefined)).toEqual({
      modeId: null,
      note: "claude's modes aren't known yet, so it starts in the default mode.",
    });
    expect(startingMode(gone, "claude", undefined).modeId).toBe("yolo");
  });

  it("starts bots made in the app blank, from a role or from a preset in that mode", () => {
    const start = (bot: Bot) => applyDefaults(bot, defaults({ approval: "ask" }), LIVE_MODES);
    expect(start(newBot("omp")).bot.modeId).toBe("ask");
    expect(start(newBot("hermes", BOT_TEMPLATES[1])).bot.modeId).toBe("default");
    expect(start(botFromPreset("claude", presetFromBot(makeBot()))).bot.modeId).toBe("default");
    expect(start(makeBot({ name: "Kit", provider: "plain" })).note).toBe(
      "Kit: plain's modes aren't known yet, so it starts in the default mode.",
    );
  });
});

describe("approval mode for imported bots", () => {
  useTempPaseoHome("paseo-bots-approval-import-");

  it("starts each imported bot in the mode its provider gets, naming the ones that fall back", async () => {
    const bots = [
      makeBot({ id: "a", name: "Ada", provider: "claude", modeId: "plan" }),
      makeBot({ id: "b", name: "Bea", provider: "hermes" }),
      makeBot({ id: "c", name: "Cy", provider: "plain" }),
    ];
    const { json } = await exportTeam({ bots, groups: [], includeMemory: false }, EMPTY_LIBRARY);
    const start = { defaults: defaults({ approval: "unattended" }), modes: LIVE_MODES };
    const imported = await importTeam({ json }, start);
    expect(imported.bots.map((entry) => entry.bot.modeId)).toEqual(["bypassPermissions", "dont_ask", null]);
    expect(imported.notes).toEqual(["Cy: plain's modes aren't known yet, so it starts in the default mode."]);
    const values: BotState = { bots: [], history: [], defaults: start.defaults };
    expect(importElevations(values, imported, LIVE_MODES)).toEqual([]);
    expect(importElevations({ ...values, defaults: defaults() }, imported, LIVE_MODES)).toHaveLength(2);
    expect((await importTeam({ json })).bots.map((entry) => entry.bot.modeId)).toEqual([null, null, null]);
  });
});

describe("elevation from the new-bot defaults", () => {
  const state = (patch: Partial<BotDefaults>, bots = [makeBot({ id: "a", name: "Ada" })]): BotState => ({
    bots,
    history: [],
    defaults: defaults(patch),
  });

  it("doesn't flag a new bot that starts in the mode the user picked in settings", () => {
    const before = state({ approval: "unattended" });
    const fresh = makeBot({ id: "n", name: "Neo", provider: "claude", modeId: "bypassPermissions" });
    const after = state({ approval: "unattended" }, [...before.bots, fresh]);
    expect(elevations(before, after, LIVE_MODES)).toEqual([]);
    expect(elevations(state({}), { ...after, defaults: defaults() }, LIVE_MODES)).toEqual([
      'Neo runs in approval mode "bypassPermissions", which acts without asking.',
    ]);
    const moved = state({ approval: "unattended" }, [
      { ...defined(before.bots[0]), modeId: "bypassPermissions" },
    ]);
    expect(elevations(before, moved, LIVE_MODES)).toHaveLength(1);
  });

  it("flags defaults that start new bots without asking", () => {
    expect(elevations(state({}), state({ approval: "unattended" }), LIVE_MODES)).toEqual([
      "New bots start in their provider's mode that acts without asking.",
    ]);
    expect(elevations(state({}), state({ modeByProvider: { omp: "full" } }), LIVE_MODES)).toEqual([
      'New omp bots start in approval mode "full", which acts without asking.',
    ]);
    expect(elevations(state({}), state({ modeByProvider: { hermes: "dont_ask" } }))).toHaveLength(1);
    expect(
      elevations(state({}), state({ approval: "ask", modeByProvider: { omp: "write" } }), LIVE_MODES),
    ).toEqual([]);
    const unattended = state({ approval: "unattended" });
    expect(
      elevations(unattended, state({ approval: "unattended", modeByProvider: { omp: "full" } }), LIVE_MODES),
    ).toEqual([]);
    const strictClaude = state({ approval: "unattended", modeByProvider: { claude: "default" } });
    expect(elevations(strictClaude, unattended, LIVE_MODES)).toEqual([
      'New claude bots start in approval mode "bypassPermissions", which acts without asking.',
    ]);
  });
});
