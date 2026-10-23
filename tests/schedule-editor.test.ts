import { describe, expect, it } from "vitest";
import { upcomingRunsOf } from "../client/panel/routines/runs";
import {
  applyRoutineDraft,
  emptyPreview,
  initialSchedulePolicy,
  previewInput,
  reducePreview,
  schedulePolicyError,
} from "../client/panel/routines/schedule-editor";
import { previewSchedule } from "../server/schedule-preview";
import type { Routine } from "../shared/bot";
import { newSchedulePolicy, SchedulePolicySchema } from "../shared/schedule-policy";

const legacy: Routine = {
  id: "routine-legacy",
  name: "Morning",
  prompt: "Report from America/New_York; shift forward and run both times.",
  enabled: false,
  schedule: { kind: "cron", expression: "30 1 * * *" },
  resultsChatId: "results-chat",
  createdAt: "2026-01-01T00:00:00Z",
  overrides: { model: "custom-user-model" },
  modeId: "ask",
};
const after = "2026-11-01T05:00:00Z";

function fallPreview() {
  return previewInput({
    schedule: legacy.schedule,
    schedulePolicy: { ...newSchedulePolicy("America/New_York"), repeat: "both" },
    since: legacy.createdAt,
    after,
    count: 2,
  });
}

const editable = (routine: Routine) => ({
  name: routine.name,
  prompt: routine.prompt,
  schedule: routine.schedule,
  resultsChatId: routine.resultsChatId,
  schedulePolicy: routine.schedulePolicy,
});

describe("schedule policy adoption and saving", () => {
  it("gives a new routine an explicit valid device-zone policy", () => {
    const policy = initialSchedulePolicy(null);
    expect(SchedulePolicySchema.parse(policy).timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    const saved = applyRoutineDraft(legacy, { ...editable(legacy), schedulePolicy: policy });
    expect(saved.schedulePolicy).toEqual(policy);
  });

  it("does not infer policy from a legacy prompt or migrate a normal edit", () => {
    expect(initialSchedulePolicy(legacy)).toBeUndefined();
    const saved = applyRoutineDraft(legacy, { ...editable(legacy), name: "Renamed" });
    expect(saved).not.toHaveProperty("schedulePolicy");
    expect(saved).toEqual({ ...legacy, name: "Renamed" });
  });

  it("adopts explicit choices without changing results routing, identity, pause or execution settings", () => {
    const policy = {
      ...newSchedulePolicy("Asia/Kathmandu"),
      gap: "shift_forward",
      repeat: "second",
    } as const;
    const saved = applyRoutineDraft(legacy, { ...editable(legacy), schedulePolicy: policy });
    expect(saved).toEqual({ ...legacy, schedulePolicy: policy });
    expect(initialSchedulePolicy(saved)).toEqual(policy);
  });

  it("blocks saving and previewing an invalid zone rather than falling back to local time", () => {
    const policy = { ...newSchedulePolicy("UTC"), timeZone: "Not/AZone" };
    expect(schedulePolicyError(policy)).not.toBeNull();
    expect(schedulePolicyError({ version: 1, timeZone: "UTC" })).not.toBeNull();
    expect(() => applyRoutineDraft(legacy, { ...editable(legacy), schedulePolicy: policy })).toThrow();
    expect(() => previewInput({ ...fallPreview(), schedulePolicy: policy })).toThrow();
  });
});

describe("exact draft occurrence previews", () => {
  it("snapshots unsaved fields and shows both actual instants in the repeated hour", () => {
    const draft = fallPreview();
    const snapshot = previewInput(draft);
    draft.schedule = { kind: "webhook" };
    if (draft.schedulePolicy) draft.schedulePolicy.repeat = "first";
    const shown = previewSchedule(snapshot);
    expect(shown.occurrences.map((entry) => entry.at)).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
    expect(shown.occurrences[0]?.localTime).toContain("GMT-4");
    expect(shown.occurrences[1]?.localTime).toContain("GMT-5");
  });

  it("honors the unsaved spring-gap selection and selected boundary", () => {
    const draft = fallPreview();
    draft.schedule = { kind: "cron", expression: "30 2 * * *" };
    draft.after = "2026-03-08T06:00:00Z";
    if (draft.schedulePolicy) draft.schedulePolicy.gap = "shift_forward";
    const shifted = previewSchedule(previewInput(draft));
    expect(shifted.occurrences[0]?.at).toBe("2026-03-08T07:30:00.000Z");
    if (draft.schedulePolicy) draft.schedulePolicy.gap = "skip";
    expect(previewSchedule(previewInput(draft)).occurrences[0]?.at).toBe("2026-03-09T06:30:00.000Z");
  });

  it("keeps legacy absence and distinguishes elapsed intervals from wall-clock time", () => {
    const legacyInput = previewInput({ schedule: legacy.schedule, since: legacy.createdAt, after, count: 1 });
    expect(previewSchedule(legacyInput)).toMatchObject({
      schedulePolicy: null,
      legacyLocalTime: true,
      elapsed: false,
    });
    const interval = previewInput({
      ...fallPreview(),
      schedule: { kind: "interval", minutes: 30 },
      since: after,
    });
    expect(previewSchedule(interval)).toMatchObject({
      elapsed: true,
      occurrences: [{ at: "2026-11-01T05:30:00.000Z" }, { at: "2026-11-01T06:00:00.000Z" }],
    });
  });

  it("clears preview on edits and ignores late successes and failures, including edit-back", () => {
    const old = previewSchedule(fallPreview());
    const pending = reducePreview(emptyPreview, { type: "start", token: 1 });
    const edited = reducePreview(pending, { type: "invalidate", token: 2 });
    expect(edited).toMatchObject({ pending: false, result: null, error: null });
    expect(reducePreview(edited, { type: "result", token: 1, result: old })).toBe(edited);
    const latest = reducePreview(edited, { type: "start", token: 3 });
    expect(reducePreview(latest, { type: "error", token: 1, error: "late failure" })).toBe(latest);
    const current = reducePreview(latest, { type: "result", token: 3, result: old });
    expect(current).toMatchObject({ pending: false, result: old, error: null });
    const invalidated = reducePreview(current, { type: "invalidate", token: 4 });
    expect(invalidated.result).toBeNull();
    expect(reducePreview(invalidated, { type: "result", token: 3, result: old })).toBe(invalidated);
  });

  it("uses the routine policy in upcoming list calculations", () => {
    const routine = { ...legacy, enabled: true, schedulePolicy: fallPreview().schedulePolicy };
    const upcoming = upcomingRunsOf([routine], () => undefined, new Date(after));
    expect(upcoming.slice(0, 2).map((entry) => entry.at.toISOString())).toEqual([
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T06:30:00.000Z",
    ]);
  });
});
