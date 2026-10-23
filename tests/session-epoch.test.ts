import { describe, expect, it } from "vitest";
import { RoutineRunSchema } from "../shared/rpc";
import { newSessionEpoch, SessionEpochSchema } from "../shared/runs";
import { makeRun } from "./helpers";

const INVALID_EPOCHS = [
  -1,
  -0.5,
  0.5,
  Number.NaN,
  Number.NEGATIVE_INFINITY,
  Number.POSITIVE_INFINITY,
  Number.MAX_SAFE_INTEGER + 1,
];

describe("provider-session generations", () => {
  it("distinguishes unknown provenance from a persisted first or reopened generation", () => {
    expect(SessionEpochSchema.parse(0)).toBe(0);
    const first = newSessionEpoch();
    expect(first).toBe(1);
    const reopened = newSessionEpoch(first);
    expect(reopened).toBe(2);
    expect(newSessionEpoch(41)).toBe(42);
  });

  it("accepts the maximum safe generation but refuses to advance beyond it", () => {
    expect(SessionEpochSchema.parse(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    expect(newSessionEpoch(Number.MAX_SAFE_INTEGER - 1)).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => newSessionEpoch(Number.MAX_SAFE_INTEGER)).toThrow();
  });

  it.each(INVALID_EPOCHS)(
    "rejects invalid numeric generation %s before advancing or admitting a run",
    (previous) => {
      expect(SessionEpochSchema.safeParse(previous).success).toBe(false);
      expect(() => newSessionEpoch(previous)).toThrow();
      expect(RoutineRunSchema.safeParse({ ...makeRun("invalid"), sessionEpoch: previous }).success).toBe(
        false,
      );
    },
  );

  it.each(["legacy", "ses-process", "12", "", null, true, {}])(
    "does not coerce nonnumeric epoch %j at an API boundary",
    (previous) => {
      expect(SessionEpochSchema.safeParse(previous).success).toBe(false);
      expect(() => Reflect.apply(newSessionEpoch, undefined, [previous])).toThrow();
      expect(RoutineRunSchema.safeParse({ ...makeRun("invalid"), sessionEpoch: previous }).success).toBe(
        false,
      );
    },
  );
});
