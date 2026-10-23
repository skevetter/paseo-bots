import { describe, expect, it } from "vitest";
import { EMPTY_LIBRARY } from "../shared/bot";
import { startBotChat } from "../shared/chat";
import { RoutineRunCardSchema, RoutineRunSchema } from "../shared/rpc";
import {
  describeRun,
  EXECUTION_STATUSES,
  isReviewEligible,
  isTerminal,
  PURPOSE_LABEL,
  PURPOSES,
  type Purpose,
  purposeFromLabels,
  type RunState,
  runStateIssue,
  settleTurn,
  TASK_OUTCOMES,
} from "../shared/runs";
import { type TaskContract, TaskContractSchema } from "../shared/task-contract";
import { defined, makeBot, makeRun } from "./helpers";

const verification = {
  verifier: { id: "invoice-count", digest: "a".repeat(64) },
  at: "2026-10-01T09:00:00Z",
};

const everyPair = EXECUTION_STATUSES.flatMap((executionStatus) =>
  TASK_OUTCOMES.map((taskOutcome) => ({ executionStatus, taskOutcome })),
);

describe("execution status and task outcome", () => {
  it("lets a verified outcome stand only on a completed, verified execution", () => {
    const states: RunState[] = everyPair.flatMap((pair) => [
      { ...pair, verification: null },
      { ...pair, verification },
    ]);
    const allowed = states
      .filter((state) => !runStateIssue(state))
      .map((state) => `${state.executionStatus}/${state.taskOutcome}/${state.verification ? "v" : "-"}`);
    const terminal = EXECUTION_STATUSES.filter(isTerminal);
    const unverified = TASK_OUTCOMES.filter((outcome) => !outcome.startsWith("verified"));
    expect(allowed.sort()).toEqual(
      [
        // Anything can end with an outcome nobody has judged, a human flag, or no change.
        ...terminal.flatMap((status) => unverified.map((outcome) => `${status}/${outcome}/-`)),
        // A run that hasn't ended has no outcome yet.
        ...EXECUTION_STATUSES.filter((status) => !isTerminal(status)).map((status) => `${status}/unknown/-`),
        "completed/verified_success/v",
        "completed/verified_failure/v",
      ].sort(),
    );
  });

  it("never reads a model's reply as the outcome", () => {
    // A turn ending says what the execution did. Outcomes come from verifiers, so settling can't produce one.
    for (const kind of ["completed", "failed", "canceled"] as const)
      expect(settleTurn(kind)).toEqual({ executionStatus: kind, taskOutcome: "unknown" });
  });

  it("is refused by the run schema when a run says it worked without a verification", () => {
    expect(() => RoutineRunSchema.parse({ ...makeRun("a"), taskOutcome: "verified_success" })).toThrow();
    expect(() => RoutineRunSchema.parse({ ...makeRun("b"), verification })).toThrow();
    expect(
      RoutineRunSchema.parse({ ...makeRun("c"), taskOutcome: "verified_success", verification }).taskOutcome,
    ).toBe("verified_success");
  });
});

describe("how a run is described", () => {
  it("shows success only for a verified success", () => {
    const described = everyPair.map((pair) => ({ ...pair, ...describeRun({ ...pair, skipped: null }) }));
    const claimingSuccess = described.filter(
      ({ label, tone }) => /succe|done/i.test(label) || tone === "success",
    );
    expect(claimingSuccess.map((run) => `${run.executionStatus}/${run.taskOutcome}`)).toEqual([
      "completed/verified_success",
    ]);
    const labelOf = (status: string, outcome: string) =>
      described.find((run) => run.executionStatus === status && run.taskOutcome === outcome)?.label;
    expect(labelOf("completed", "unknown")).toBe("Completed, not verified");
    expect(labelOf("completed", "needs_review")).toBe("Completed, needs review");
    expect(labelOf("canceled", "unknown")).toBe("Stopped, effects unknown");
    expect(labelOf("unknown", "unknown")).toBe("Outcome unknown");
  });

  it("names a skipped run by why it was skipped", () => {
    const skipped = { executionStatus: "canceled", taskOutcome: "no_change" } as const;
    expect(describeRun({ ...skipped, skipped: "busy" }).label).toBe("Skipped, still working");
    expect(describeRun({ ...skipped, skipped: "missed" }).label).toBe("Missed");
  });
});

describe("which turns a review may read", () => {
  it("takes only task turns that ended as completed or failed", () => {
    const eligible: string[] = [];
    for (const purpose of [...PURPOSES, null])
      for (const executionStatus of EXECUTION_STATUSES)
        if (isReviewEligible({ purpose, executionStatus })) eligible.push(`${purpose}/${executionStatus}`);
    expect(eligible).toEqual(["task/completed", "task/failed"]);
  });

  it("reads a chat made before purposes existed as a task and an unknown purpose as none", () => {
    expect(purposeFromLabels({})).toBe("task");
    expect(purposeFromLabels(undefined)).toBe("task");
    expect(purposeFromLabels({ [PURPOSE_LABEL]: "memory_review" })).toBe("memory_review");
    expect(purposeFromLabels({ [PURPOSE_LABEL]: "Maintenance" })).toBeNull();
    expect(purposeFromLabels({ [PURPOSE_LABEL]: "" })).toBeNull();
  });
});

describe("routine run cards posted before outcomes existed", () => {
  const old = {
    routineName: "Orders",
    trigger: "webhook",
    scheduledFor: "2026-09-01T09:00:00Z",
    agentId: "chat",
    output: "Shipped.",
    error: null,
  };

  it("show a completed turn with an unknown outcome", () => {
    expect(RoutineRunCardSchema.parse({ ...old, status: "succeeded" })).toEqual({
      ...old,
      executionStatus: "completed",
      taskOutcome: "unknown",
      skipped: null,
    });
    expect(RoutineRunCardSchema.parse({ ...old, status: "skipped-missed" })).toMatchObject({
      executionStatus: "canceled",
      skipped: "missed",
    });
  });

  it("don't read a status this version doesn't know as a success", () => {
    expect(RoutineRunCardSchema.parse({ ...old, status: "approved" })).toMatchObject({
      executionStatus: "unknown",
      taskOutcome: "unknown",
    });
  });
});

const contract: TaskContract = {
  version: 1,
  taskClass: "invoice.send",
  goal: "Send this month's invoices to every client with an open order.",
  requiredInputs: [{ name: "month", description: "The month, as YYYY-MM.", type: "text" }],
  outputSchema: { type: "object", required: ["sent"], properties: { sent: { type: "integer" } } },
  verifiers: [{ id: "invoice-count", digest: "b".repeat(64) }],
  permittedSideEffects: ["external_message"],
  capabilities: ["gmail.send"],
  deadlineSeconds: 3600,
  replayMode: "reconcile_first",
  evidenceRequirements: ["tool_result", "verifier_report"],
};

describe("task contracts", () => {
  it("accepts a contract that names its verifier by id and digest", () => {
    expect(TaskContractSchema.parse(contract)).toEqual(contract);
    expect(
      TaskContractSchema.parse({ ...contract, outputSchema: null, evidenceRequirements: [] }),
    ).toBeTruthy();
  });

  it("has nowhere to put code for the check", () => {
    const withCode = { ...contract, verifiers: [{ ...contract.verifiers[0], script: "return true" }] };
    expect(TaskContractSchema.safeParse(withCode).success).toBe(false);
    expect(TaskContractSchema.safeParse({ ...contract, verifierCode: "return true" }).success).toBe(false);
    expect(
      TaskContractSchema.safeParse({
        ...contract,
        verifiers: [{ id: "invoice-count", digest: "not-a-digest" }],
      }).success,
    ).toBe(false);
  });

  it("rejects contracts that contradict themselves", () => {
    const issues = (patch: Partial<TaskContract>) =>
      TaskContractSchema.safeParse({ ...contract, ...patch }).error?.issues.map((issue) => issue.message);
    expect(issues({ permittedSideEffects: ["none", "network_write"] })).toEqual([
      "none can't be combined with other side effects",
    ]);
    expect(issues({ outputSchema: null, evidenceRequirements: ["output_schema_match"] })).toEqual([
      "output_schema_match needs an output schema",
    ]);
    expect(issues({ verifiers: [] })).toEqual(["verifier_report needs a verifier"]);
    expect(issues({ capabilities: ["gmail.send", "gmail.send"] })).toEqual(["A capability is listed twice"]);
    expect(issues({ deadlineSeconds: 0 })).toHaveLength(1);
    expect(issues({ permittedSideEffects: [] })).toHaveLength(1);
  });
});

describe("the purpose a chat is started with", () => {
  async function labelsOf(purpose: Purpose | undefined, labels: Record<string, string> = {}) {
    const created: { labels: Record<string, string> }[] = [];
    const workspace = {
      current: () => null,
      refresh: async () => null,
      setTitle: async () => undefined,
      archive: async () => undefined,
      agents: {
        create: async (options: { labels: Record<string, string> }) => {
          created.push(options);
          return { id: "chat-1" };
        },
      },
    };
    const api = {
      projects: { list: async () => ({ projects: [] }) },
      workspaces: {
        list: async () => ({ entries: [] }),
        ref: () => workspace,
        open: async () => workspace,
        create: async () => workspace,
      },
      providers: { snapshot: async () => ({ entries: [] }) },
    } as never;
    await startBotChat(api, {
      bot: makeBot({ model: "m" }),
      library: EMPTY_LIBRARY,
      policy: {},
      placement: { path: "/bots/inbox", projectRoot: null },
      prompt: "p",
      systemPrompt: "s",
      labels,
      ...(purpose ? { purpose } : {}),
    });
    return defined(created[0]).labels;
  }

  it("is a task unless the caller says otherwise, and extra labels can't change it", async () => {
    expect((await labelsOf(undefined))[PURPOSE_LABEL]).toBe("task");
    expect((await labelsOf("memory_review"))[PURPOSE_LABEL]).toBe("memory_review");
    expect((await labelsOf("maintenance", { [PURPOSE_LABEL]: "task" }))[PURPOSE_LABEL]).toBe("maintenance");
  });
});
