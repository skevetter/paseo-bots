import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cancellationMessage,
  immutableSnapshotFacts,
  runDetailEvidenceFacts,
  withAuthoritativeRun,
} from "../client/automations/run-presentation";
import { getRunDetails } from "../server/run-details";
import type { PreparedChatMetadata } from "../shared/chat";
import { budgetMemory, budgetStats } from "../shared/memory-budget";
import { resolveBot } from "../shared/policies";
import type { RoutineRun } from "../shared/rpc";
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
      artifact: { id: "snapshot-1", sha256: "a".repeat(64) },
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
  it("redacts private locators, output, configuration, permission rules and unknown nested fields", async () => {
    const { metadata, run, coordinator } = fixture();
    const privateMetadata = {
      ...metadata,
      config: { prompt: "private-prompt", env: { TOKEN: "private-secret" } },
      permissionEnvelope: {
        ...metadata.permissionEnvelope,
        appRules: {
          privateApp: { tools: "all" as const, account: "private-account", token: "private-token" },
        },
        headers: { Authorization: "private-token" },
      },
      memoryContextReceipt: { ...defined(metadata.memoryContextReceipt), text: "private-memory" },
      playbooks: [{ ...metadata.playbooks[0], instructions: "private-instructions" }],
    };
    const privateRun = {
      ...run,
      output: "private-output",
      managed: {
        ...defined(run.managed),
        config: "private-config",
        artifact: { ...defined(run.managed).artifact, path: "/private/snapshot.json" },
      },
    };
    const details = await getRunDetails(
      {
        ...coordinator,
        get: async () => privateRun,
        snapshot: async () => ({ status: "available", metadata: privateMetadata }),
      },
      run.id,
    );
    expect(details.run?.output).toBeNull();
    expect(JSON.stringify(details)).not.toContain("private");
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
    expect(Object.fromEntries(immutableSnapshotFacts(details.snapshot))["Input reference 1"]).toContain(
      "not a content hash",
    );
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
    expect(details.snapshot.execution.model.source.layer).toBe("bot");
    expect(details.snapshot.routingReason).toBeNull();
    const before = JSON.stringify(details);
    metadata.resolvedPolicy.model.source.layer = "routine";
    defined(metadata.memoryContextReceipt).stats.includedBytes = 999;
    metadata.playbooks[0].contentHash = "f".repeat(64);
    defined(run.managed).artifact.sha256 = "f".repeat(64);
    expect(JSON.stringify(details)).toBe(before);
    const facts = Object.fromEntries(immutableSnapshotFacts(details.snapshot));
    expect(facts["Selected model"]).toBe("admitted-model");
    expect(facts["Requested model"]).toBe("Provider default");
    expect(facts["Memory omitted"]).toBe("1 lines; 6 bytes");
    expect(facts["Memory truncation"]).toBe("lines");
    expect(facts["Playbook 1"]).toContain("version v3");
  });
});

describe("unavailable run snapshots", () => {
  it("reports missing retained snapshots without echoing private failure details or substituting current settings", async () => {
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
    expect(Object.fromEntries(immutableSnapshotFacts(details.snapshot))["Immutable snapshot"]).toContain(
      "not substituted",
    );
    expect(details.resultArtifacts).toEqual({ status: "unavailable" });
    expect(details.evidenceArtifacts).toEqual({ status: "unavailable" });
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
  it("preserves retained evidence references and distinguishes incomplete timeline evidence from verification", async () => {
    const { coordinator, run } = fixture();
    const retainedRun: RoutineRun = {
      ...run,
      managed: {
        ...defined(run.managed),
        result: { id: "result-1", sha256: "f".repeat(64) },
        evidence: {
          artifact: { id: "evidence-1", sha256: "e".repeat(64) },
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
      artifact: { id: "result-1", sha256: "f".repeat(64) },
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
    const facts = Object.fromEntries(runDetailEvidenceFacts(details));
    expect(facts["Reply complete"]).toBe("false");
    expect(facts["Timeline complete"]).toBe("false");
    expect(facts["Result artifacts"]).toContain("content SHA-256");
    expect(facts["External-action receipts"]).toContain("Unavailable");
  });

  it("retains pinned verifier identity and digest independently of snapshot availability", async () => {
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
  it("keeps authoritative pending cancellation and its reservation while preserving immutable detail metadata", async () => {
    const { run, coordinator } = fixture();
    const details = await getRunDetails(coordinator, run.id);
    const active: RoutineRun = {
      ...run,
      output: "private-cancel-output",
      executionStatus: "running",
      endedAt: null,
      managed: { ...defined(run.managed), cancelRequested: true, reservation: true },
    };
    const updated = withAuthoritativeRun(details, active);
    expect(updated.run?.executionStatus).toBe("running");
    expect(updated.run?.managed?.reservation).toBe(true);
    expect(updated.run?.output).toBeNull();
    expect(updated.snapshot).toBe(details.snapshot);
    expect(cancellationMessage(defined(updated.run))).toContain("not confirmed");
    expect(Object.fromEntries(runDetailEvidenceFacts(updated))["Replay policy"]).toContain("No task retry");
    expect(withAuthoritativeRun(undefined, active).snapshot).toEqual({
      status: "unavailable",
      reason: "not_loaded",
    });
    const completed = withAuthoritativeRun(updated, {
      ...active,
      executionStatus: "completed",
      endedAt: "2026-10-23T02:00:00Z",
      managed: { ...defined(active.managed), reservation: false },
    });
    expect(completed.run?.taskOutcome).toBe("unknown");
    expect(completed.run?.managed?.reservation).toBe(false);
    expect(cancellationMessage(defined(completed.run))).toContain("recorded execution is completed");
    expect(cancellationMessage(defined(completed.run))).not.toContain("are retained");
  });
});
