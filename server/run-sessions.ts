import { resolve } from "node:path";
import type { PreparedBotChat } from "../shared/chat";
import type { SessionOpening } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import { newOperationId, newSessionEpoch, type SessionEpoch, SessionEpochSchema } from "../shared/runs";
import type { RunArtifacts } from "./run-artifacts";
import type { RunSnapshot, RunStore } from "./run-store";

export interface ManagedSessionOpening {
  agentId: string;
  workspaceId: string | null;
  provider: string;
  cwd: string;
  reason: "create" | "resume" | "refresh" | "import";
  purpose: "interactive" | "history";
}
export interface ManagedSessionReceipt {
  sessionEpoch: SessionEpoch;
  requestId: string;
}

/** The hook observes provider-session boundaries, not plugin process lifetimes. */
export class ManagedSessions {
  constructor(
    private readonly store: RunStore,
    private readonly artifacts: RunArtifacts,
    private readonly now: () => number,
  ) {}

  opened(input: ManagedSessionOpening): Promise<ManagedSessionReceipt | null> {
    if (input.purpose === "history") return Promise.resolve(null);
    return this.store.updateState((state) => this.openInState(state, input));
  }

  private async openInState(
    state: RunSnapshot,
    input: ManagedSessionOpening,
  ): Promise<ManagedSessionReceipt | null> {
    const run = Object.values(state.routines)
      .flatMap((record) => record.runs)
      .find((entry) => entry.agentId === input.agentId && entry.managed);
    if (!run?.managed) return null;
    await this.validateRun(run, input);
    const history = state.coordinator.sessions[input.agentId] ?? [];
    const previous = history.at(-1);
    this.checkPlacement(previous, input);
    this.checkDeadline(run.managed);
    if (previous?.state === "pending" || (input.reason === "create" && previous)) {
      if (previous.executionId !== run.executionId)
        throw new Error("Pending provider session belongs to another execution.");
      return { sessionEpoch: SessionEpochSchema.parse(previous.sessionEpoch), requestId: previous.requestId };
    }
    const sessionEpoch = newSessionEpoch(previous?.sessionEpoch ?? 0);
    const opening: SessionOpening = {
      sessionEpoch,
      requestId: newOperationId(),
      executionId: run.executionId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      cwd: resolve(input.cwd),
      reason: input.reason,
      state: "pending",
      openedAt: this.now(),
      activeAt: null,
    };
    history.push(opening);
    state.coordinator.sessions[input.agentId] = history;
    run.sessionEpoch = sessionEpoch;
    return { sessionEpoch, requestId: opening.requestId };
  }

  private async validateRun(run: RoutineRun, input: ManagedSessionOpening): Promise<void> {
    if (
      !run.managed ||
      run.managed.launchIntent === false ||
      ["queued", "reserved", "canceled"].includes(run.executionStatus) ||
      run.skipped
    )
      throw new Error("Managed execution has no started provider-session intent.");
    const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
    const expected = artifact.prepared;
    if (
      input.agentId !== expected.agentId ||
      input.provider !== expected.provider ||
      resolve(input.cwd) !== resolve(expected.placement.path)
    )
      throw new Error(
        "Managed provider-session identity does not match the admitted provider and working directory.",
      );
  }

  active(agentId: string, expectedEpoch?: number): Promise<void> {
    return this.store.updateState((state) => {
      const opening = state.coordinator.sessions[agentId]?.at(-1);
      if (!opening || opening.state === "active") return;
      if (expectedEpoch !== undefined && opening.sessionEpoch !== expectedEpoch) return;
      const run = Object.values(state.routines)
        .flatMap((record) => record.runs)
        .find((entry) => entry.agentId === agentId && entry.executionId === opening.executionId);
      if (!run?.managed || run.managed.launchIntent === false)
        throw new Error("Provider-session activation has no matching managed execution.");
      opening.state = "active";
      opening.activeAt = this.now();
      this.acknowledgeAgent(run);
    });
  }

  private acknowledgeAgent(run: RoutineRun): void {
    if (!run.managed) throw new Error("Missing managed agent activation.");
    run.managed.hostCreatedAt ??= this.now();
    if (run.executionStatus === "starting") run.executionStatus = "running";
  }

  private checkPlacement(previous: SessionOpening | undefined, input: ManagedSessionOpening): void {
    if (!previous) return;
    if (
      previous.workspaceId !== input.workspaceId ||
      previous.provider !== input.provider ||
      previous.cwd !== resolve(input.cwd)
    )
      throw new Error("Managed provider-session placement changed; explicit new admission is required.");
  }

  private checkDeadline(managed: {
    deadlineAt?: number | null;
    firstReservedAt?: number | null;
    maxRunSeconds?: number | null;
  }): void {
    const wall =
      managed.firstReservedAt !== undefined && managed.firstReservedAt !== null && managed.maxRunSeconds
        ? managed.firstReservedAt + managed.maxRunSeconds * 1000
        : Infinity;
    if (this.now() >= Math.min(managed.deadlineAt ?? Infinity, wall))
      throw new Error("Managed execution deadline expired before provider-session opening.");
  }
}
