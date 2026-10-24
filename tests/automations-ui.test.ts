import { describe, expect, it } from "vitest";
import {
  cancellationMessage,
  canRequestCancel,
  elapsedFact,
  snapshotFacts,
} from "../client/automations/run-presentation";
import {
  backFromAutomations,
  INITIAL_RUN_PAGES,
  runListInput,
  runPages,
} from "../client/automations/run-state";
import { getRunDetails } from "../server/run-details";
import type { RoutineRun } from "../shared/rpc";
import type { SafeRun } from "../shared/run-details";
import { defined, makeRun } from "./helpers";

function managedRun(status: RoutineRun["executionStatus"] = "running"): RoutineRun {
  return makeRun("opaque:run/1", {
    executionStatus: status,
    endedAt: null,
    managed: {
      botId: "bot-a",
      routineId: "routine-a",
      requestId: "request-a",
      artifact: { id: "artifact-a", sha256: "a".repeat(64) },
      provider: "omp",
      model: "openai-codex/gpt-6.1-sol",
      systemPromptHash: "b".repeat(64),
      userPromptHash: null,
      environmentVersion: null,
      resourceIds: ["resource-a"],
      overlap: "queue",
      overlapLimit: 1,
      reservation: true,
      notBefore: 0,
      attempts: [],
      timeline: { epoch: "timeline-a", seq: 4 },
      creation: { key: "creation-a", revision: 1, phase: "confirmed", outcomeUnknown: false },
      cancelRequested: false,
      coalescedInto: null,
    },
  });
}

async function safeRun(run: RoutineRun): Promise<SafeRun> {
  const details = await getRunDetails(
    { get: async () => run, snapshot: async () => ({ status: "unavailable", reason: "expired" }) },
    run.id,
  );
  return defined(details.run);
}

describe("automation cursor navigation", () => {
  it("keeps opaque cursor bytes and restores previous pages without deriving offsets", () => {
    const second = runPages(INITIAL_RUN_PAGES, { type: "next", cursor: "opaque:/a?b=+%20==" });
    const third = runPages(second, { type: "next", cursor: "opaque:next" });
    expect(runListInput(second).cursor).toBe("opaque:/a?b=+%20==");
    expect(runListInput(runPages(third, { type: "previous" })).cursor).toBe("opaque:/a?b=+%20==");
    expect(runPages(INITIAL_RUN_PAGES, { type: "previous" })).toBe(INITIAL_RUN_PAGES);
    expect(runPages(third, { type: "next", cursor: null })).toBe(third);
    expect(runListInput(runPages(third, { type: "reload" })).cursor).toBeUndefined();
  });

  it("restarts server pagination and clears another bot's routine when bot changes", () => {
    let pages = runPages(INITIAL_RUN_PAGES, {
      type: "filter",
      filters: { botId: "bot-a", routineId: "", executionStatus: "unknown" },
    });
    pages = runPages(pages, { type: "filter", filters: { ...pages.filters, routineId: "routine-a" } });
    pages = runPages(pages, { type: "next", cursor: "bot-a-page-2" });
    expect(runListInput(pages)).toMatchObject({
      botId: "bot-a",
      routineId: "routine-a",
      executionStatus: "unknown",
      cursor: "bot-a-page-2",
    });
    pages = runPages(pages, { type: "filter", filters: { ...pages.filters, botId: "bot-b" } });
    expect(runListInput(pages)).toEqual({
      botId: "bot-b",
      executionStatus: "unknown",
      limit: 25,
      cursor: undefined,
    });
    expect(pages.cursors).toEqual([undefined]);
    pages = runPages(pages, { type: "next", cursor: "bot-b-page-2" });
    pages = runPages(pages, { type: "filter", filters: { ...pages.filters, executionStatus: "failed" } });
    expect(runListInput(pages)).toEqual({
      botId: "bot-b",
      executionStatus: "failed",
      limit: 25,
      cursor: undefined,
    });
  });

  it("steps back through run details before dismissing automations", () => {
    const list = backFromAutomations({ runId: "opaque:run" });
    expect(list).toEqual({ runId: null });
    expect(backFromAutomations(list ?? { runId: "unexpected" })).toBeNull();
  });
});

describe("automation evidence", () => {
  it("never presents an unsupported active cancellation as canceled or releases its reservation", async () => {
    const raw = managedRun();
    if (!raw.managed) throw new Error("managed fixture missing");
    raw.managed.cancelRequested = true;
    const run = await safeRun(raw);
    const before = structuredClone(run);
    expect(cancellationMessage(run)).toContain("not confirmed");
    expect(cancellationMessage(run)).toContain("Reservation and unknown effects are retained");
    expect(canRequestCancel(run)).toBe(true);
    expect(run).toEqual(before);
    expect(cancellationMessage({ ...run, executionStatus: "canceled" })).toContain(
      "external effects remain unknown",
    );
    expect(canRequestCancel({ ...run, executionStatus: "canceled" })).toBe(false);
  });

  it("keeps unknown reserved work actionable without claiming it stopped", async () => {
    const run = await safeRun(managedRun("unknown"));
    expect(cancellationMessage(run)).toContain("Reconcile before assuming this work stopped");
    expect(canRequestCancel(run)).toBe(true);
    if (!run.managed) throw new Error("managed fixture missing");
    run.managed.reservation = false;
    expect(canRequestCancel(run)).toBe(false);
    const historic = await safeRun(makeRun("historic", { executionStatus: "running", endedAt: null }));
    expect(canRequestCancel(historic)).toBe(false);
  });

  it("projects safe references and evidence but never serializes snapshot contents", async () => {
    const raw = managedRun();
    if (!raw.managed) throw new Error("managed fixture missing");
    const withPrivateExtras = {
      ...raw,
      output: "private reply",
      managed: {
        ...raw.managed,
        systemPrompt: "private system prompt",
        environment: { TOKEN: "private credential" },
        artifact: { ...raw.managed.artifact, content: "private artifact" },
      },
    };
    const facts = Object.fromEntries(snapshotFacts(await safeRun(withPrivateExtras)));
    expect(facts).toMatchObject({
      "Bot ID": "bot-a",
      "Routine ID": "routine-a",
      "Request ID": "request-a",
      Provider: "omp",
      Model: "openai-codex/gpt-6.1-sol",
      "Resource count": "1",
      "Timeline sequence": "4",
      "Creation outcome unknown": "false",
      "Reservation retained": "true",
    });
    expect(JSON.stringify(facts)).not.toContain("private");
    expect(snapshotFacts(await safeRun(makeRun("historic")))).toEqual([
      ["Snapshot", "No managed snapshot metadata available for this record"],
    ]);
  });

  it("uses observed end times and labels missing or invalid time evidence honestly", () => {
    const run = makeRun("timed", { startedAt: "2026-10-23T00:00:00Z", endedAt: "2026-10-23T00:01:05Z" });
    expect(elapsedFact(run, Date.parse("2026-10-23T12:00:00Z"))).toBe("1m 5s between recorded start and end");
    expect(elapsedFact({ ...run, endedAt: null }, Date.parse("2026-10-23T00:01:05Z"))).toContain(
      "end not observed",
    );
    expect(elapsedFact({ ...run, startedAt: "unavailable" }, Date.now())).toBe("Unavailable");
    expect(elapsedFact({ ...run, endedAt: "2026-10-22T00:00:00Z" }, Date.now())).toBe("Unavailable");
  });
});
