import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";
import { type Cadence, INTERVAL, useCadence } from "../client/panel/routines/cadence";
import { applyRoutineDraft, previewInput } from "../client/panel/routines/schedule-editor";
import { previewSchedule } from "../server/schedule-preview";
import type { Routine, RoutineSchedule } from "../shared/bot";
import { CRON_PRESETS, upcomingRuns } from "../shared/routines";
import { newSchedulePolicy } from "../shared/schedule-policy";

const mounted: ReactTestRenderer[] = [];
afterEach(() => {
  act(() => {
    for (const renderer of mounted) renderer.unmount();
  });
  mounted.length = 0;
});

function mount(original: RoutineSchedule) {
  let latest: Cadence | null = null;
  function Probe() {
    latest = useCadence(original);
    return null;
  }
  act(() => {
    mounted.push(create(createElement(Probe)));
  });
  const cadence = () => {
    if (!latest) throw new Error("cadence not mounted");
    return latest;
  };
  return { cadence, act: (fn: (c: Cadence) => void) => act(() => fn(cadence())) };
}

const base: Routine = {
  id: "routine-elapsed",
  name: "Elapsed",
  prompt: "Check the queue",
  enabled: false,
  schedule: { kind: "interval", minutes: 90 },
  resultsChatId: "results-chat",
  createdAt: "2026-01-01T00:07:00Z",
};
const since = base.createdAt;
const after = "2026-01-01T00:30:00Z";

describe("elapsed interval cadence in the editor", () => {
  it("opens a 90-minute interval as elapsed minutes, not a rounded cron", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    expect(h.cadence().presetValue).toBe(INTERVAL);
    expect(h.cadence().schedule).toEqual({ kind: "interval", minutes: 90 });
    expect(h.cadence().intervalText).toBe("90");
    expect(h.cadence().cronError).toBeNull();
    expect(h.cadence().intervalError).toBeNull();
  });

  it("saves an untouched 90-minute interval with its elapsed phase", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    const saved = applyRoutineDraft(base, {
      name: base.name,
      prompt: base.prompt,
      schedule: h.cadence().schedule,
      resultsChatId: base.resultsChatId,
      schedulePolicy: newSchedulePolicy("UTC"),
    });
    expect(saved.schedule).toEqual({ kind: "interval", minutes: 90 });
    expect(saved.enabled).toBe(false);
    expect(saved.createdAt).toBe(base.createdAt);
    const runs = upcomingRuns(saved.schedule, new Date(saved.createdAt), new Date(after), {
      count: 2,
      policy: newSchedulePolicy("UTC"),
    });
    expect(runs.map((at) => at.toISOString())).toEqual([
      "2026-01-01T01:37:00.000Z",
      "2026-01-01T03:07:00.000Z",
    ]);
  });

  it("previews the same elapsed phase that save uses", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    const preview = previewSchedule(
      previewInput({
        schedule: h.cadence().schedule,
        schedulePolicy: newSchedulePolicy("UTC"),
        since,
        after,
        count: 2,
      }),
    );
    expect(preview.elapsed).toBe(true);
    expect(preview.occurrences.map((occurrence) => occurrence.at)).toEqual([
      "2026-01-01T01:37:00.000Z",
      "2026-01-01T03:07:00.000Z",
    ]);
  });

  it("keeps the exact minutes typed in the field", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    for (const minutes of [120, 5, 1440, 45]) {
      h.act((c) => c.editInterval(String(minutes)));
      expect(h.cadence().intervalError).toBeNull();
      expect(h.cadence().schedule).toEqual({ kind: "interval", minutes });
    }
  });

  it("flags invalid minutes and never rounds them into the schedule", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    for (const text of ["90.5", "4", "1441", "", "abc", "-5"]) {
      h.act((c) => c.editInterval(text));
      expect(h.cadence().intervalError).not.toBeNull();
      expect(h.cadence().schedule).toEqual({ kind: "interval", minutes: 90 });
    }
  });

  it("keeps typed minutes across a preset round trip", () => {
    const h = mount({ kind: "interval", minutes: 90 });
    h.act((c) => c.editInterval("45"));
    h.act((c) => c.choosePreset(CRON_PRESETS[0].id));
    expect(h.cadence().schedule.kind).toBe("cron");
    h.act((c) => c.choosePreset(INTERVAL));
    expect(h.cadence().schedule).toEqual({ kind: "interval", minutes: 45 });
    expect(h.cadence().intervalError).toBeNull();
  });

  it("does not let a hidden invalid cron block an elapsed interval", () => {
    const h = mount({ kind: "cron", expression: "0 9 * * *" });
    h.act((c) => c.editCron("not a cron"));
    expect(h.cadence().cronError).not.toBeNull();
    h.act((c) => c.choosePreset(INTERVAL));
    expect(h.cadence().cronError).toBeNull();
    expect(h.cadence().schedule.kind).toBe("interval");
  });
});
