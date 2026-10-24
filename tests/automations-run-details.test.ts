import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { cancellationMessage } from "../client/automations/run-presentation";
import { getRunDetails } from "../server/run-details";
import type { PreparedChatMetadata } from "../shared/chat";
import { budgetMemory, budgetStats } from "../shared/memory-budget";
import { resolveBot } from "../shared/policies";
import type { RoutineRun } from "../shared/rpc";
import { hasCreationProof } from "../shared/run-details";
import { defined, makeBot, makeRun } from "./helpers";

function fixture() {
  const bot = makeBot({ provider: "omp", model: "admitted-model" });
  const metadata: PreparedChatMetadata = {
    resolvedPolicy: resolveBot({}, bot),
    permissionEnvelope: {
      modeId: null,
      alwaysAllow: ["safe-tool-name"],
      contactBots: "ask",
      mcpServerNames: ["private-mcp-name"],
      apps: ["private-app-name"],
      appRules: {},
    },
    systemPromptHash: "b".repeat(64),
    userPromptHash: "c".repeat(64),
    memoryContextReceipt: {
      backend: "files",
      contentHash: "d".repeat(64),
      stats: budgetStats(budgetMemory("one\ntwo\nthree", { maxLines: 2, maxBytes: 100 })),
    },
    playbooks: [{ id: "playbook-1", version: "v3", contentHash: "e".repeat(64) }],
    inputArtifactRefs: ["https://private.example/path?token=private-token", "/private/home/input.txt"],
    environmentVersion: "environment-v1",
  };
  const run = makeRun("run-detail", {
    managed: {
      botId: bot.id,
      routineId: "routine-1",
      requestId: "request-1",
      artifact: { id: "a".repeat(64), sha256: "a".repeat(64) },
      provider: "omp",
      model: "admitted-model",
      systemPromptHash: metadata.systemPromptHash,
      userPromptHash: metadata.userPromptHash,
      environmentVersion: "environment-v1",
      resourceIds: [],
      overlap: "queue",
      overlapLimit: 1,
      reservation: true,
      notBefore: 0,
      attempts: [],
      timeline: null,
      creation: null,
      cancelRequested: false,
      coalescedInto: null,
    },
  });
  const coordinator = {
    get: async (_id: string) => run,
    snapshot: async (_id: string) => ({ status: "available" as const, metadata }),
  };
  return { bot, metadata, run, coordinator };
}

describe("safe retained run details", () => {
  it("projects only allowlisted fields and turns retained errors into presence diagnostics", async () => {
    const { metadata, run } = fixture();
    metadata.environmentVersion = "SECRET-context-environment";
    const secretRun: RoutineRun = {
      ...run,
      output: "SECRET-output",
      error: "SECRET-run-error",
      managed: {
        ...defined(run.managed),
        cancelError: "SECRET-cancel",
        clientMessageId: "SECRET-client-message",
        resourceIds: ["SECRET-resource-/private/home"],
        evidencePins: ["SECRET-evidence-pin"],
        environmentVersion: "SECRET-environment-locator",
        timeline: { epoch: "SECRET-provider-session", seq: 4 },
        creation: { key: "SECRET-creation-key", revision: 2, phase: "SECRET-phase", outcomeUnknown: true },
        attempts: [
          {
            attemptId: "att-1",
            executionId: "exe-1",
            agentId: "agent-1",
            idempotencyKey: "SECRET-idempotency",
            number: 1,
            state: "failed",
            error: "SECRET-attempt",
          },
        ],
        artifact: { id: "a".repeat(64), sha256: "a".repeat(64), path: "/private/snapshot.json" },
      } as RoutineRun["managed"],
    };
    const privateBefore = JSON.stringify(secretRun);
    const details = await getRunDetails(
      {
        get: async () => secretRun,
        snapshot: async () => ({
          status: "available",
          metadata: {
            ...metadata,
            config: { prompt: "SECRET-prompt", env: { TOKEN: "SECRET-env" } },
          } as PreparedChatMetadata,
        }),
      },
      run.id,
    );
    const serialized = JSON.stringify(details);
    for (const secret of [
      "SECRET",
      "/private/snapshot",
      "private-token",
      "/private/home",
      "private-mcp-name",
      "private-app-name",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(details.run).not.toHaveProperty("output");
    expect(details.run).not.toHaveProperty("error");
    expect(details.run?.errorDiagnostic).toBe("retained");
    expect(details.run?.managed?.cancelDiagnostic).toBe("retained");
    expect(details.run?.managed?.attempts[0]?.diagnostic).toBe("retained");
    expect(details.run?.managed?.attempts[0]).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(secretRun)).toBe(privateBefore);
  });
});

describe("safe immutable references and snapshot fields", () => {
  it("withholds invalid snapshot, result and evidence locators without inventing a digest", async () => {
    const { run, coordinator } = fixture();
    const invalidReference = { id: "/private/artifact.json", sha256: "SECRET-not-a-digest" };
    const invalid = makeRun("run-invalid", {
      managed: {
        ...defined(run.managed),
        artifact: invalidReference,
        result: invalidReference,
        evidence: {
          artifact: invalidReference,
          source: "timeline",
          replyComplete: false,
          timelineComplete: false,
          observedAt: 0,
        },
      },
    });
    const details = await getRunDetails({ ...coordinator, get: async () => invalid }, run.id);
    for (const projection of [details.snapshot, details.resultArtifacts, details.evidenceArtifacts])
      expect(projection).toEqual({ status: "unavailable", reason: "invalid_reference" });
    expect(JSON.stringify(details)).not.toContain("/private");
    expect(JSON.stringify(details)).not.toContain("SECRET");
  });

  it("refuses a mismatched content-addressed digest pair instead of claiming a recorded artifact", async () => {
    const { run, coordinator } = fixture();
    const invalid = makeRun("run-mismatched", {
      managed: { ...defined(run.managed), result: { id: "a".repeat(64), sha256: "b".repeat(64) } },
    });
    const details = await getRunDetails({ ...coordinator, get: async () => invalid }, run.id);
    expect(details.resultArtifacts).toEqual({ status: "unavailable", reason: "invalid_reference" });
  });

  it("hashes input locators into not-checked references", async () => {
    const { metadata, run, coordinator } = fixture();
    const details = await getRunDetails(coordinator, run.id);
    if (details.snapshot.status !== "available") throw new Error("Expected retained snapshot");
    expect(details.snapshot.inputArtifacts).toEqual(
      metadata.inputArtifactRefs.map((locator) => {
        const sha256 = createHash("sha256").update(locator).digest("hex");
        return { id: `sha256:${sha256}`, sha256, availability: "not_checked" };
      }),
    );
    expect(details.snapshot.permissions).toEqual({
      modeId: null,
      contactBots: "ask",
      preapprovedToolCount: 1,
      mcpServerCount: 1,
      appCount: 1,
    });
  });

  it("uses admitted policy and actual selected model without consulting current mutable bot settings", async () => {
    const { bot, metadata, run, coordinator } = fixture();
    metadata.resolvedPolicy.model.value = null;
    bot.provider = "changed-provider";
    bot.model = "changed-model";
    const details = await getRunDetails(coordinator, run.id);
    if (details.snapshot.status !== "available") throw new Error("Expected retained snapshot");
    expect(details.snapshot.selected).toEqual({ provider: "omp", model: "admitted-model" });
    expect(details.snapshot.execution.model.value).toBeNull();
    expect(details.snapshot.routingReason).toBeNull();
    const before = JSON.stringify(details);
    metadata.resolvedPolicy.model.source.layer = "routine";
    defined(metadata.memoryContextReceipt).stats.includedBytes = 999;
    metadata.playbooks[0].contentHash = "f".repeat(64);
    defined(run.managed).artifact.sha256 = "f".repeat(64);
    expect(JSON.stringify(details)).toBe(before);
  });
});

describe("creation proof", () => {
  it.each(["legacy_ack", "historical_host_receipt", "planned_only"] as const)(
    "preserves the actual positive-evidence boundary for %s",
    async (evidence) => {
      const { run, coordinator } = fixture();
      const observed = makeRun(`run-${evidence}`, {
        agentId: "assigned-native-id",
        agentCreationStatus: evidence === "legacy_ack" ? "created" : "unknown",
        managed:
          evidence === "historical_host_receipt"
            ? { ...defined(run.managed), hostCreatedAt: 1_700_000_000_000 }
            : undefined,
      });
      const details = await getRunDetails({ ...coordinator, get: async () => observed }, observed.id);
      expect(hasCreationProof(defined(details.run))).toBe(evidence !== "planned_only");
    },
  );
});

describe("unavailable run snapshots", () => {
  it("reports missing retained snapshots without echoing private failure details", async () => {
    const { run, coordinator } = fixture();
    const details = await getRunDetails(
      {
        ...coordinator,
        snapshot: async () => ({
          status: "unavailable",
          reason: "Missing /private/snapshot.json token=secret",
        }),
      },
      run.id,
    );
    expect(details.snapshot).toEqual({ status: "unavailable", reason: "retained_snapshot_unavailable" });
    expect(JSON.stringify(details)).not.toContain("/private");
    expect(details.resultArtifacts).toEqual({ status: "unavailable", reason: "absent" });
    expect(details.evidenceArtifacts).toEqual({ status: "unavailable", reason: "absent" });
    expect(details.externalActionReceipts).toEqual({ status: "unavailable" });
  });

  it("does not read private snapshots for missing or legacy runs", async () => {
    const { coordinator } = fixture();
    const neverSnapshot = async (): Promise<never> => {
      throw new Error("Must not read a snapshot");
    };
    const missing = await getRunDetails({ get: async () => null, snapshot: neverSnapshot }, "missing");
    expect(missing.run).toBeNull();
    expect(missing.snapshot).toEqual({ status: "unavailable", reason: "run_not_found" });
    const legacy = await getRunDetails(
      { ...coordinator, get: async () => makeRun("legacy"), snapshot: neverSnapshot },
      "legacy",
    );
    expect(legacy.snapshot).toEqual({ status: "unavailable", reason: "not_managed" });
  });
});

describe("retained run evidence and recovery", () => {
  it("retains typed suppression facts independently from private error text", async () => {
    const { coordinator } = fixture();
    const suppressed = makeRun("run-coalesced", {
      executionStatus: "canceled",
      agentCreationStatus: "not_created",
      skipped: "missed",
      error: "SECRET-diagnostic-/private/retained-file",
      recovery: {
        reason: "coalesced",
        count: 3,
        firstDue: "2026-10-23T01:00:00.000Z",
        plannedThrough: "2026-10-23T04:00:00.000Z",
        into: "2026-10-23T04:00:00.000Z",
      },
    });
    const details = await getRunDetails({ ...coordinator, get: async () => suppressed }, suppressed.id);
    expect(details.run?.recovery.receipt).toEqual(suppressed.recovery);
    expect(details.run?.taskOutcome).toBe("unknown");
    expect(details.run?.agentCreationStatus).toBe("not_created");
    expect(JSON.stringify(details)).not.toContain("SECRET");
    expect(JSON.stringify(details)).not.toContain("/private");
  });

  it("keeps evidence references and marks incomplete timeline evidence without inventing verification", async () => {
    const { coordinator, run } = fixture();
    const retainedRun: RoutineRun = {
      ...run,
      managed: {
        ...defined(run.managed),
        result: { id: "f".repeat(64), sha256: "f".repeat(64) },
        evidence: {
          artifact: { id: "e".repeat(64), sha256: "e".repeat(64) },
          source: "timeline",
          replyComplete: false,
          timelineComplete: false,
          observedAt: Date.parse("2026-10-23T00:00:00Z"),
        },
      },
    };
    const details = await getRunDetails({ ...coordinator, get: async () => retainedRun }, run.id);
    expect(details.resultArtifacts).toEqual({
      status: "recorded",
      artifact: { id: "f".repeat(64), sha256: "f".repeat(64) },
      availability: "not_checked",
    });
    expect(details.evidenceArtifacts).toMatchObject({
      status: "recorded",
      source: "timeline",
      replyComplete: false,
      timelineComplete: false,
    });
    expect(details.run?.taskOutcome).toBe("unknown");
    expect(details.run?.verification).toBeNull();
  });

  it("retains pinned verifier identity independently of snapshot availability", async () => {
    const { run, coordinator } = fixture();
    const verified = {
      ...run,
      taskOutcome: "verified_success" as const,
      verification: {
        verifier: { id: "approved-verifier-v2", digest: "f".repeat(64) },
        at: "2026-10-23T01:00:00Z",
      },
    };
    const details = await getRunDetails(
      {
        ...coordinator,
        get: async () => verified,
        snapshot: async () => ({ status: "unavailable", reason: "expired" }),
      },
      run.id,
    );
    expect(details.run?.verification).toEqual(verified.verification);
    expect(details.snapshot.status).toBe("unavailable");
    expect(details.externalActionReceipts.status).toBe("unavailable");
  });
});

describe("cancellation evidence transitions", () => {
  it("keeps pending cancellation reserved, then clears the reservation on completion", async () => {
    const { run, coordinator } = fixture();
    const active: RoutineRun = {
      ...run,
      executionStatus: "running",
      endedAt: null,
      managed: { ...defined(run.managed), cancelRequested: true, reservation: true },
    };
    const pending = await getRunDetails({ ...coordinator, get: async () => active }, run.id);
    expect(pending.run?.managed?.reservation).toBe(true);
    expect(cancellationMessage(defined(pending.run))).toContain("not confirmed");

    const completed: RoutineRun = {
      ...active,
      executionStatus: "completed",
      endedAt: "2026-10-23T02:00:00Z",
      managed: { ...defined(active.managed), reservation: false },
    };
    const done = await getRunDetails({ ...coordinator, get: async () => completed }, run.id);
    expect(done.run?.taskOutcome).toBe("unknown");
    expect(done.run?.managed?.reservation).toBe(false);
    expect(cancellationMessage(defined(done.run))).not.toContain("are retained");
  });
});
