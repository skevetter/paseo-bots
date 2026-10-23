import { describe, expect, it } from "vitest";
import {
  type HostAgentEvidence,
  type HostTimelineEvidence,
  hostRunEvidence,
} from "../server/run-host-evidence";
import { EXECUTION_LABEL, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { ExecutionIdSchema, providerTurnId as hostTurnId, RunIdSchema } from "../shared/runs";
import { makeRun } from "./helpers";

const STARTED_AT = "2026-10-23T10:00:00.000Z";
const AGENT_ID = "177a9200-2b69-4260-b808-088e1dbd9371";
const OTHER_AGENT_ID = "ce30d865-cd68-49d9-b6bd-321cc6b93f6d";

function admittedRun(patch: Partial<RoutineRun> = {}): RoutineRun {
  return makeRun("run-admitted", {
    agentId: AGENT_ID,
    executionId: ExecutionIdSchema.parse("exe-admitted"),
    executionStatus: "unknown",
    scheduledFor: STARTED_AT,
    startedAt: STARTED_AT,
    endedAt: null,
    ...patch,
  });
}

function hostAgent(run: RoutineRun, patch: Partial<HostAgentEvidence> = {}): HostAgentEvidence {
  return {
    id: AGENT_ID,
    status: "idle",
    labels: { [RUN_LABEL]: run.id, [EXECUTION_LABEL]: run.executionId },
    pendingPermissions: [],
    activeTurn: null,
    attentionReason: "finished",
    attentionTimestamp: "2026-10-23T10:01:00.000Z",
    ...patch,
  };
}

function hostTimeline(run: RoutineRun, patch: Partial<HostTimelineEvidence> = {}): HostTimelineEvidence {
  return {
    endCursor: { epoch: "host-epoch", seq: 4 },
    error: null,
    gap: false,
    staleCursor: false,
    hasNewer: false,
    entries: [
      { seqEnd: 1, item: { type: "assistant_message", text: "An older execution's reply" } },
      { seqEnd: 2, item: { type: "user_message", clientMessageId: run.executionId, text: "Admitted task" } },
      { seqEnd: 3, item: { type: "tool_call" } },
      { seqEnd: 4, item: { type: "assistant_message", text: "Current execution's reply" } },
    ],
    ...patch,
  };
}

const IDENTITY_MISMATCHES: { reason: string; patch: Partial<HostAgentEvidence> }[] = [
  { reason: "agent UUID", patch: { id: OTHER_AGENT_ID } },
  { reason: "run label", patch: { labels: { [RUN_LABEL]: "other-run", [EXECUTION_LABEL]: "exe-admitted" } } },
  {
    reason: "execution label",
    patch: { labels: { [RUN_LABEL]: "run-admitted", [EXECUTION_LABEL]: "other" } },
  },
  { reason: "missing run label", patch: { labels: { [EXECUTION_LABEL]: "exe-admitted" } } },
  { reason: "missing execution label", patch: { labels: { [RUN_LABEL]: "run-admitted" } } },
];

describe("host execution identity", () => {
  it.each(IDENTITY_MISMATCHES)("refuses adoption and completion with a mismatching $reason", ({ patch }) => {
    const run = admittedRun();
    const timeline = hostTimeline(run);
    for (const status of ["running", "idle"]) {
      const agent = hostAgent(run, { ...patch, status, activeTurn: { turnId: "repeated" } });
      expect(hostRunEvidence(run, agent, timeline).status).toBe("unknown");
    }
  });

  it("does not treat a provider turn ID shared with another execution as identity", () => {
    const run = admittedRun({ providerTurnId: hostTurnId("repeated") });
    const agent = hostAgent(run, { activeTurn: { turnId: "repeated" } });
    const otherRun = admittedRun({
      id: RunIdSchema.parse("other-run"),
      executionId: ExecutionIdSchema.parse("exe-other"),
      providerTurnId: hostTurnId("repeated"),
    });
    expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("completed");
    expect(hostRunEvidence(otherRun, agent, hostTimeline(run)).status).toBe("unknown");
  });
});

describe("admitted prompt evidence", () => {
  it.each([undefined, "other-execution"])(
    "refuses a last prompt with clientMessageId=%s",
    (clientMessageId) => {
      const run = admittedRun();
      const timeline = hostTimeline(run, {
        entries: [{ seqEnd: 1, item: { type: "user_message", clientMessageId, text: "Admitted task" } }],
      });
      for (const status of ["running", "idle"]) {
        expect(hostRunEvidence(run, hostAgent(run, { status }), timeline).status).toBe("unknown");
      }
    },
  );

  it("refuses another prompt even when this execution's earlier prompt is present", () => {
    const run = admittedRun();
    const timeline = hostTimeline(run);
    timeline.entries.push({
      seqEnd: 5,
      item: { type: "user_message", clientMessageId: "another-prompt", text: "A new task" },
    });
    timeline.endCursor = { epoch: "host-epoch", seq: 5 };
    expect(hostRunEvidence(run, hostAgent(run), timeline).status).toBe("unknown");
    expect(hostRunEvidence(run, hostAgent(run, { status: "running" }), timeline).status).toBe("unknown");
  });

  it.each([
    { reason: "empty timeline", entries: [] },
    {
      reason: "assistant-only timeline",
      entries: [{ seqEnd: 1, item: { type: "assistant_message", text: "All done" } }],
    },
  ])("does not adopt an active agent without its admitted user prompt: $reason", ({ entries }) => {
    const run = admittedRun();
    const agent = hostAgent(run, { status: "running" });
    expect(hostRunEvidence(run, agent, hostTimeline(run, { entries })).status).toBe("unknown");
  });
});

describe("incomplete timeline evidence", () => {
  it.each([
    { reason: "gap", patch: { gap: true } },
    { reason: "stale cursor", patch: { staleCursor: true } },
    { reason: "newer unobserved entries", patch: { hasNewer: true } },
    { reason: "transport error", patch: { error: "Timeline unavailable" } },
  ])("does not adopt or settle when there is a $reason", ({ patch }) => {
    const run = admittedRun();
    const timeline = hostTimeline(run, patch);
    for (const status of ["running", "idle"]) {
      const result = hostRunEvidence(run, hostAgent(run, { status }), timeline);
      expect(result.status).toBe("unknown");
      expect(result.output).toBeNull();
      expect(result.error).toBeNull();
    }
  });
});

describe("active host adoption", () => {
  it.each(["running", "initializing"])("adopts a matching %s agent", (status) => {
    const run = admittedRun();
    const timeline = hostTimeline(run);
    const agent = hostAgent(run, { status, activeTurn: { turnId: "provider-turn" } });
    expect(hostRunEvidence(run, agent, timeline)).toMatchObject({
      status: "running",
      providerTurnId: "provider-turn",
      cursor: timeline.endCursor,
      output: null,
      error: null,
    });
  });

  it.each([null, "repeated"])("does not require a unique provider turn ID: %s", (turnId) => {
    const run = admittedRun({ providerTurnId: hostTurnId("repeated") });
    const agent = hostAgent(run, { status: "running", activeTurn: turnId === null ? null : { turnId } });
    expect(hostRunEvidence(run, agent, hostTimeline(run))).toMatchObject({
      status: "running",
      providerTurnId: turnId,
    });
  });

  it("requires matching prompt evidence before accepting pending user permissions", () => {
    const run = admittedRun();
    const agent = hostAgent(run, { status: "running", pendingPermissions: [{ id: "permission" }] });
    expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("waiting_for_user");
    expect(hostRunEvidence(run, agent, hostTimeline(run, { entries: [] })).status).toBe("unknown");
  });

  it("does not mistake an active turn's previous finished attention for completion", () => {
    const run = admittedRun();
    const agent = hostAgent(run, { status: "running", attentionReason: "finished" });
    expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("running");
  });
});

describe("terminal host attention", () => {
  it.each([
    ["finished", "completed"],
    ["error", "failed"],
  ] as const)("settles %s at the exact admitted start boundary", (attentionReason, expected) => {
    const run = admittedRun();
    const agent = hostAgent(run, {
      attentionReason,
      attentionTimestamp: STARTED_AT,
      lastError: "Provider failed",
    });
    const result = hostRunEvidence(run, agent, hostTimeline(run));
    expect(result.status).toBe(expected);
    expect(result.error).toBe(attentionReason === "error" ? "Provider failed" : null);
  });

  it.each([null, undefined, "not-a-date", "2026-10-23T09:59:59.999Z"])(
    "does not settle attention with timestamp %s",
    (attentionTimestamp) => {
      const run = admittedRun();
      for (const attentionReason of ["finished", "error"]) {
        const agent = hostAgent(run, { attentionReason, attentionTimestamp });
        expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("unknown");
      }
    },
  );

  it.each([null, undefined, "permission", "canceled"])(
    "does not settle attention reason %s",
    (attentionReason) => {
      const run = admittedRun();
      const agent = hostAgent(run, { attentionReason });
      expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("unknown");
    },
  );

  it("does not settle when the admitted start timestamp cannot be compared", () => {
    const run = admittedRun({ startedAt: "not-a-date" });
    for (const attentionReason of ["finished", "error"]) {
      expect(hostRunEvidence(run, hostAgent(run, { attentionReason }), hostTimeline(run)).status).toBe(
        "unknown",
      );
    }
  });

  it.each([null, "repeated"])("settles without depending on the historical turn ID: %s", (providerTurnId) => {
    const run = admittedRun({ providerTurnId: hostTurnId(providerTurnId) });
    const agent = hostAgent(run, { activeTurn: providerTurnId === null ? null : { turnId: providerTurnId } });
    expect(hostRunEvidence(run, agent, hostTimeline(run)).status).toBe("completed");
  });
});

describe("terminal output and outcome evidence", () => {
  it("takes the last reply after the admitted prompt, not a preceding execution's output", () => {
    const run = admittedRun();
    const timeline = hostTimeline(run);
    timeline.entries.push({ seqEnd: 5, item: { type: "assistant_message", text: "Final current reply" } });
    timeline.endCursor = { epoch: "host-epoch", seq: 5 };
    expect(hostRunEvidence(run, hostAgent(run), timeline)).toMatchObject({
      status: "completed",
      output: "Final current reply",
      cursor: { epoch: "host-epoch", seq: 5 },
    });
  });

  it("does not reuse an old reply when completion has no response after the matching prompt", () => {
    const run = admittedRun();
    const timeline = hostTimeline(run);
    timeline.entries = timeline.entries.slice(0, 2);
    timeline.endCursor = { epoch: "host-epoch", seq: 2 };
    expect(hostRunEvidence(run, hostAgent(run), timeline)).toMatchObject({
      status: "completed",
      output: null,
    });
  });

  it("does not turn a model's verification claims into a verified task outcome", () => {
    const run = Object.freeze(admittedRun());
    const timeline = hostTimeline(run, {
      entries: [
        { seqEnd: 1, item: { type: "user_message", clientMessageId: run.executionId } },
        { seqEnd: 2, item: { type: "assistant_message", text: "verified_success: all checks passed" } },
      ],
    });
    const result = hostRunEvidence(run, hostAgent(run), timeline);
    expect(result.status).toBe("completed");
    expect(run.taskOutcome).toBe("unknown");
    expect(run.verification).toBeNull();
    expect(result.output).toBe("verified_success: all checks passed");
  });

  it("does not interpret an assistant error claim as host execution failure", () => {
    const run = admittedRun();
    const timeline = hostTimeline(run, {
      entries: [
        { seqEnd: 1, item: { type: "user_message", clientMessageId: run.executionId } },
        { seqEnd: 2, item: { type: "assistant_message", text: "Task failed; verified_failure" } },
      ],
    });
    expect(hostRunEvidence(run, hostAgent(run), timeline)).toMatchObject({
      status: "completed",
      error: null,
    });
  });
});
