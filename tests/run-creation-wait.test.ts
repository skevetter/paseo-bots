import { describe, expect, it } from "vitest";
import { CreationWaits } from "../server/run-creation-wait";
import type { RoutineRun } from "../shared/rpc";
import { makeRun } from "./helpers";

async function wait(run: RoutineRun) {
  const waits = new CreationWaits(async () => run, 0);
  try {
    return await waits.wait(run.id);
  } finally {
    await waits.close();
  }
}

describe("creation evidence independent of task outcomes", () => {
  it("never treats historic no-change or a selected UUID as no-create proof", async () => {
    const unverified = { ...makeRun("old-no-change"), taskOutcome: "no_change" as const, agentId: "planned" };
    expect((await wait(unverified)).status).toBe("pending");
    const verified = {
      ...unverified,
      verification: { verifier: { id: "deterministic-check", digest: "a".repeat(64) }, at: "2026-10-23" },
    };
    expect((await wait(verified)).status).toBe("pending");
    expect((await wait({ ...verified, agentCreationStatus: "unknown" })).status).toBe("pending");
  });

  it("requires terminal execution for negative proof and gives positive evidence precedence", async () => {
    const run = makeRun("creation-state", {
      executionStatus: "starting",
      endedAt: null,
      agentId: "chosen",
      agentCreationStatus: "not_created",
    });
    expect((await wait(run)).status).toBe("pending");
    expect((await wait({ ...run, executionStatus: "failed" })).status).toBe("not_created");
    expect((await wait({ ...run, executionStatus: "failed", agentCreationStatus: "created" })).status).toBe(
      "created",
    );
    expect(
      (await wait({ ...run, executionStatus: "failed", agentId: null, agentCreationStatus: "created" }))
        .status,
    ).toBe("pending");
  });
});
