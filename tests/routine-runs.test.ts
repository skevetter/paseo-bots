import { describe, expect, it } from "vitest";
import { routineState, runStartError, withRunStart } from "../client/panel/routines/runs";
import type { Routine } from "../shared/bot";
import type { RoutineRun } from "../shared/rpc";

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

  it("shows why a run couldn't start until the routine runs again", () => {
    const earlier: RoutineRun = {
      id: "run-1",
      trigger: "schedule",
      scheduledFor: "2026-09-01T09:00:00Z",
      startedAt: "2026-09-01T09:00:00Z",
      endedAt: "2026-09-01T09:01:00Z",
      status: "succeeded",
      agentId: "a1",
      output: null,
      error: null,
    };
    const failed = { status: "failed", error: "Routine not found", lastRunId: "run-1" } as const;
    expect(runStartError(failed, earlier)).toBe("Couldn't start the run: Routine not found");
    expect(runStartError(failed, { ...earlier, id: "run-2", startedAt: "2026-09-01T10:00:00Z" })).toBeNull();
    expect(runStartError({ status: "failed", error: "Offline", lastRunId: null }, undefined)).toBe(
      "Couldn't start the run: Offline",
    );
    expect(runStartError({ status: "starting" }, earlier)).toBeNull();
    expect(runStartError(undefined, earlier)).toBeNull();
  });

  it("replaces and clears one routine's start without touching the others", () => {
    const starts = withRunStart({ other: { status: "starting" } }, "rt", { status: "starting" });
    const failure = { status: "failed", error: "x", lastRunId: null } as const;
    const failed = withRunStart(starts, "rt", failure);
    expect(failed).toEqual({ other: { status: "starting" }, rt: failure });
    expect(withRunStart(failed, "rt", null)).toEqual({ other: { status: "starting" } });
    expect(starts).toEqual({ other: { status: "starting" }, rt: { status: "starting" } });
  });
});
