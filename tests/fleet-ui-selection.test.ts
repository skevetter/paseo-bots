import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  type FleetFilters,
  filterFleet,
  selectionKey,
  toggleSelection,
} from "../client/fleet/selection";
import type { Bot } from "../shared/bot";
import type { FleetRow } from "../shared/fleet";
import { type Inheritable, type Resolution, resolveBot } from "../shared/policies";
import { defined, makeBot } from "./helpers";

function fixtureBot(index: number): Bot {
  const inheritance: Inheritable[][] = [
    ["provider", "model", "thinkingOptionId"],
    ["model", "thinkingOptionId"],
    ["thinkingOptionId"],
  ];
  return makeBot({
    id: `opaque:${index}/bot`,
    name: "Repeated name",
    provider: "stored-provider",
    model: "stored-model",
    policy:
      index % 4 === 3
        ? undefined
        : {
            binding: index % 7 === 0 ? { policyId: "pol-bound", revision: null } : null,
            inherit: inheritance[index % 4],
          },
  });
}

function fixtureResolution(bot: Bot, index: number): Resolution {
  const resolution = resolveBot({}, { ...bot, policy: undefined });
  resolution.provider = {
    value: index % 4 < 2 ? "omp" : "codex",
    source: { layer: "global", policyId: "pol-global", revision: 1 },
  };
  resolution.model = {
    value: index % 5 < 3 ? "sol" : "luna",
    source: { layer: "team", policyId: "pol-model", revision: 2 },
  };
  if (index % 2 === 1)
    resolution.budget.maxRunCostUsd = {
      value: 1,
      source: { layer: "team", policyId: "pol-budget", revision: 1 },
    };
  if (index % 11 === 0)
    resolution.roles.reviewer.provider = {
      value: "omp",
      source: { layer: "bot_policy", policyId: "pol-reviewer", revision: 1 },
    };
  if (index % 10 === 0) {
    resolution.ok = false;
    resolution.issues = [
      { code: "capability_unknown", field: "requirements", message: "Unknown capability" },
    ];
  }
  return resolution;
}

function fixtureRow(index: number): FleetRow {
  const bot = fixtureBot(index);
  return {
    bot,
    resolution: fixtureResolution(bot, index),
    teamId: index % 2 === 0 ? "team-alpha" : "team-beta",
    teamName: "Repeated team name",
    lastOutcome: "unknown",
    executionStatus: index % 3 === 0 ? "running" : index % 3 === 1 ? "completed" : null,
    activeWork: index % 2 === 0 ? null : 1,
    spendUsd: index % 2 === 0 ? null : 0.5,
    attention: [],
  };
}

const fleet = Object.freeze(Array.from({ length: 100 }, (_, index) => fixtureRow(index)));

function ids(indices: number[]): string[] {
  return indices.map((index) => `opaque:${index}/bot`);
}

function filteredIds(filters: Partial<FleetFilters>): string[] {
  return filterFleet(fleet, { ...EMPTY_FILTERS, ...filters }).map((row) => row.bot.id);
}

describe("fleet filtering", () => {
  it("filters 100 bots by team IDs, not duplicate display names", () => {
    expect(filteredIds({ team: "team-alpha" })).toEqual(ids(Array.from({ length: 50 }, (_, i) => i * 2)));
    expect(filteredIds({ team: "Repeated team name" })).toEqual([]);
  });

  it("uses effective providers and models rather than stored overrides", () => {
    expect(filteredIds({ provider: "omp" })).toEqual(
      ids(Array.from({ length: 25 }, (_, i) => [i * 4, i * 4 + 1]).flat()),
    );
    expect(filteredIds({ model: "luna" })).toEqual(
      ids(Array.from({ length: 20 }, (_, i) => [i * 5 + 3, i * 5 + 4]).flat()),
    );
    expect(filteredIds({ provider: "stored-provider" })).toEqual([]);
    expect(filteredIds({ model: "stored-model" })).toEqual([]);
  });

  it("matches execution status without treating unknown outcomes or absent status as completion", () => {
    expect(filteredIds({ status: "completed" })).toEqual(
      ids(Array.from({ length: 33 }, (_, i) => i * 3 + 1)),
    );
    expect(filteredIds({ status: "unknown" })).toEqual([]);
    expect(filteredIds({ status: "verified_success" })).toEqual([]);
  });

  it("finds bot bindings even when no effective field comes from the bound policy", () => {
    expect(filteredIds({ policy: "pol-bound" })).toEqual(ids([0, 14, 21, 28, 42, 49, 56, 70, 77, 84, 98]));
  });

  it("finds global, team budget and delegated role policy sources", () => {
    expect(filteredIds({ policy: "pol-global" })).toEqual(ids(Array.from({ length: 100 }, (_, i) => i)));
    expect(filteredIds({ policy: "pol-budget" })).toEqual(
      ids(Array.from({ length: 50 }, (_, i) => i * 2 + 1)),
    );
    expect(filteredIds({ policy: "pol-reviewer" })).toEqual(ids([0, 11, 22, 33, 44, 55, 66, 77, 88, 99]));
    expect(filteredIds({ policy: "pol-missing" })).toEqual([]);
  });

  it("includes partial overrides, legacy explicit overrides and resolution issues as exceptions", () => {
    const explicit = Array.from({ length: 25 }, (_, i) => [i * 4 + 1, i * 4 + 2, i * 4 + 3]).flat();
    expect(filteredIds({ exceptions: true })).toEqual(
      ids([...explicit, 0, 20, 40, 60, 80].sort((a, b) => a - b)),
    );
  });

  it("intersects all six filters without changing row values or unknown metrics", () => {
    const filters = Object.freeze({
      team: "team-alpha",
      provider: "omp",
      model: "sol",
      policy: "pol-global",
      status: "running",
      exceptions: true,
    });
    const before = structuredClone(fleet);
    const rows = filterFleet(fleet, filters);
    expect(rows).toEqual([fleet[0], fleet[60]]);
    expect(rows.map((row) => [row.activeWork, row.spendUsd, row.lastOutcome])).toEqual([
      [null, null, "unknown"],
      [null, null, "unknown"],
    ]);
    expect(fleet).toEqual(before);
    expect(filterFleet(fleet, { ...filters, team: "team-beta" }).map((row) => row.bot.id)).toEqual(
      ids([21, 45, 57, 81]),
    );
  });

  it("does not match a missing effective model or missing team to a named filter", () => {
    const row = fixtureRow(1);
    row.resolution.model.value = null;
    row.teamId = null;
    expect(filterFleet([row], { ...EMPTY_FILTERS, model: "luna" })).toEqual([]);
    expect(filterFleet([row], { ...EMPTY_FILTERS, team: "team-beta" })).toEqual([]);
    expect(filterFleet([row], EMPTY_FILTERS)).toEqual([row]);
  });
});

describe("exact fleet selection", () => {
  it("toggles opaque IDs, not duplicate names, without changing caller arrays", () => {
    const selected = Object.freeze(ids([99]));
    const visibleIds = Object.freeze(ids([0, 1]));
    const added = toggleSelection({
      selected,
      visibleIds,
      botId: "opaque:1/bot",
      anchor: null,
      range: false,
    });
    expect(added).toEqual({ selected: ids([99, 1]), anchor: "opaque:1/bot" });
    expect(toggleSelection({ ...added, visibleIds, botId: "opaque:1/bot", range: false })).toEqual({
      selected: ids([99]),
      anchor: "opaque:1/bot",
    });
    expect(selected).toEqual(ids([99]));
    expect(visibleIds).toEqual(ids([0, 1]));
  });

  it("keeps hidden selected IDs when filters change and ranges only over visible rows", () => {
    const visibleIds = filteredIds({ team: "team-alpha" });
    const result = toggleSelection({
      selected: ids([99, 2]),
      visibleIds,
      botId: "opaque:8/bot",
      anchor: "opaque:2/bot",
      range: true,
    });
    expect(result).toEqual({ selected: ids([99, 2, 4, 6, 8]), anchor: "opaque:2/bot" });
    expect(filteredIds({ team: "team-beta" })).not.toContain("opaque:8/bot");
    expect(result.selected).toEqual(ids([99, 2, 4, 6, 8]));
  });

  it("selects reversed ranges inclusively, preserves the anchor and never duplicates IDs", () => {
    expect(
      toggleSelection({
        selected: ids([4, 2, 4]),
        visibleIds: ids([0, 2, 4, 6]),
        botId: "opaque:0/bot",
        anchor: "opaque:4/bot",
        range: true,
      }),
    ).toEqual({ selected: ids([4, 2, 0]), anchor: "opaque:4/bot" });
  });

  it("keeps a one-row range selected even when the anchor was already selected", () => {
    expect(
      toggleSelection({
        selected: ids([2]),
        visibleIds: ids([2]),
        botId: "opaque:2/bot",
        anchor: "opaque:2/bot",
        range: true,
      }),
    ).toEqual({ selected: ids([2]), anchor: "opaque:2/bot" });
  });

  it.each([null, "opaque:99/bot"])(
    "falls back to a plain toggle for an absent visible anchor %s",
    (anchor) => {
      expect(
        toggleSelection({
          selected: ids([99]),
          visibleIds: ids([0, 2]),
          botId: "opaque:2/bot",
          anchor,
          range: true,
        }),
      ).toEqual({ selected: ids([99, 2]), anchor: "opaque:2/bot" });
    },
  );

  it("does not derive an accidental range from a hidden target or an empty viewport", () => {
    for (const visibleIds of [ids([0, 2]), []]) {
      expect(
        toggleSelection({
          selected: ids([0]),
          visibleIds,
          botId: "opaque:99/bot",
          anchor: "opaque:0/bot",
          range: true,
        }),
      ).toEqual({ selected: ids([0, 99]), anchor: "opaque:99/bot" });
    }
  });

  it.each([" ", "Spacebar", "Enter"])("toggles the exact focused ID for keyboard activation %j", (key) => {
    const visibleIds = filteredIds({ provider: "omp" });
    const botId = defined(visibleIds[4]);
    const selected = selectionKey(key)
      ? toggleSelection({ selected: ids([99]), visibleIds, botId, anchor: null, range: false }).selected
      : ids([99]);
    expect(selected).toEqual(ids([99, 8]));
  });

  it.each(["Escape", "ArrowDown", "Tab", "", "a"])("does not activate selection for %j", (key) => {
    expect(selectionKey(key)).toBe(false);
  });
});
