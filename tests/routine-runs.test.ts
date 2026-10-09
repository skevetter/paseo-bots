import { describe, expect, it } from "vitest";
import { routineState, runStartError, withRunStart } from "../client/panel/routines/runs";
import type { Routine } from "../shared/bot";

const routine: Routine = {
  id: "rt",
  name: "Morning brief",
  prompt: "p",
  enabled: true,
  schedule: { kind: "interval", minutes: 60 },
  resultsChatId: null,
  createdAt: "2026-09-01T00:00:00",
};

describe("Run now state", () => {
  it("shows a starting run in the badge, even on a paused routine", () => {
    const starting = { status: "starting" } as const;
    expect(routineState(routine, new Date(), starting)).toEqual({ label: "Starting...", variant: "muted" });
    expect(routineState({ ...routine, enabled: false }, null, starting).label).toBe("Starting...");
    expect(routineState(routine, new Date(), undefined)).toEqual({ label: "Active", variant: "success" });
  });

  it("shows why a run couldn't start, and nothing otherwise", () => {
    expect(runStartError({ status: "failed", error: "Routine not found" })).toBe(
      "Couldn't start the run: Routine not found",
    );
    expect(runStartError({ status: "starting" })).toBeNull();
    expect(runStartError(undefined)).toBeNull();
  });

  it("replaces and clears one routine's start without touching the others", () => {
    const starts = withRunStart({ other: { status: "starting" } }, "rt", { status: "starting" });
    const failed = withRunStart(starts, "rt", { status: "failed", error: "x" });
    expect(failed).toEqual({ other: { status: "starting" }, rt: { status: "failed", error: "x" } });
    expect(withRunStart(failed, "rt", null)).toEqual({ other: { status: "starting" } });
    expect(starts).toEqual({ other: { status: "starting" }, rt: { status: "starting" } });
  });
});
