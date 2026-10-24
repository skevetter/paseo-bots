import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Bot, BotState, Routine } from "../shared/bot";
import type { CreationEvidence, PreparedBotChat, PreparedChatMetadata } from "../shared/chat";
import { PreparedLaunchNotCreatedError } from "../shared/chat";
import { HostCapabilityError } from "../shared/host-capability";
import { EXECUTION_LABEL, type HostReadiness, OCCURRENCE_LABEL, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRecord, RoutineRun } from "../shared/rpc";
import {
  isTerminal,
  newAttemptId,
  newExecutionId,
  type Purpose,
  providerTurnId,
  SessionEpochSchema,
  type Trigger,
} from "../shared/runs";
import { newUuid } from "../shared/uuid";
import { PLUGIN_VERSION } from "../shared/version";
import { launchPreparedChat, prepareChat, refreshPreparedChat } from "./chats";
import { CoordinatorLock } from "./coordinator-lock";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import {
  type CapacityLimits,
  capacityBlock,
  DEFAULT_CAPACITY,
  overlapDecision,
  ProvenInfrastructureError,
  providerCircuitDecision,
  providerCircuitFailure,
  providerCircuitSuccess,
  retryDelay,
} from "./run-admission-policy";
import { RunArtifacts } from "./run-artifacts";
import { type CreationWaitResult, CreationWaits } from "./run-creation-wait";
import {
  BoundedHostCalls,
  deadlineOf,
  expireBeforeLaunch,
  HostCallNotDispatchedError,
} from "./run-deadlines";
import type { HostTimelineEvidence } from "./run-host-evidence";
import { type HostRunEvidence, hostRunEvidence } from "./run-host-evidence";
import { admitRun, appendRun, emptyRecord, type RunSnapshot, RunStore } from "./run-store";

export type { CreationWaitResult } from "./run-creation-wait";

import {
  existingRequest,
  type LegacyAdmission,
  type ReplayRequest,
  rememberRequest,
  requestHashOf,
  requestKey,
} from "./run-requests";
import { type ManagedSessionOpening, type ManagedSessionReceipt, ManagedSessions } from "./run-sessions";

export type { ManagedSessionOpening, ManagedSessionReceipt } from "./run-sessions";

function controllerRuntimeVersion(): string {
  const bun = process.versions.bun;
  return bun ? `bun/${bun}` : `node/${process.versions.node}`;
}

export interface Admission {
  bot: Bot;
  state: BotState;
  routine?: Routine;
  trigger: Trigger;
  due: Date;
  requestId: string;
  prompt: string;
  title: string;
  labels?: Record<string, string>;
  purpose?: Purpose;
  resourceIds?: string[];
  overlap?: "skip" | "queue" | "coalesce";
  requestHash?: string;
  deferLaunch?: boolean;
  deadlineAt?: number;
}
export interface PreparedAdmission {
  routineId?: string;
  trigger: Trigger;
  due: Date;
  requestId: string;
  resourceIds?: string[];
  overlap?: "skip" | "queue" | "coalesce";
  capacity?: Partial<CapacityLimits>;
  state?: BotState;
  requestHash?: string;
  deferLaunch?: boolean;
  deadlineAt?: number;
}
export interface CoordinatorOptions {
  store?: RunStore;
  now?: () => number;
  jitter?: () => number;
  capacity?: Partial<CapacityLimits>;
  prepare?: typeof prepareChat;
  launch?: typeof launchPreparedChat;
  refresh?: typeof refreshPreparedChat;
  cancel?: (agentId: string) => Promise<void>;
  launchTimeoutMs?: number;
  reconcileIntervalMs?: number;
}
export interface RunFilter {
  cursor?: string;
  limit?: number;
  botId?: string;
  routineId?: string;
  executionStatus?: RoutineRun["executionStatus"];
}
export interface ExecutionEnd {
  kind: "completed" | "failed" | "canceled";
  turnId?: string | null;
  reply?: string;
  error?: string | null;
  executionId?: string;
  /** Authentic generation captured with the completion, never inferred at delivery. */
  sessionEpoch?: number;
  routineId?: string;
}
interface LaunchFailure {
  error: unknown;
  evidence: CreationEvidence | null;
  created: boolean;
}
const allRuns = (state: RunSnapshot) => Object.values(state.routines).flatMap((record) => record.runs);
const lookup = (state: RunSnapshot, id: string) => allRuns(state).find((run) => run.id === id);
const copy = <T>(value: T): T => structuredClone(value);
const holds = (run: RoutineRun) => run.managed?.reservation === true;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The sole admission boundary. An uncertain host call is reconciled, never replayed. */
export class RunCoordinator {
  readonly store: RunStore;
  private readonly artifacts: RunArtifacts;
  private readonly lock: CoordinatorLock;
  private readonly sessions: ManagedSessions;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly capacity: CapacityLimits;
  private recovery: Promise<void> | null = null;
  private readonly launches = new Map<string, Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private readonly opened: Promise<void>;
  private stopped = false;
  private closing = false;
  private wake: NodeJS.Timeout | undefined;
  private periodic: NodeJS.Timeout | undefined;
  private observing: Promise<void> | null = null;
  private readonly calls: BoundedHostCalls;
  private readonly creationWaits: CreationWaits;
  private readonly detach: () => void;
  private state: HostReadiness = "waiting_for_host_api";

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
    private readonly options: CoordinatorOptions = {},
  ) {
    this.store = options.store ?? new RunStore();
    const directory = dirname(this.store.path);
    this.artifacts = new RunArtifacts(directory);
    this.lock = new CoordinatorLock(directory);
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? Math.random;
    this.capacity = { ...DEFAULT_CAPACITY, ...options.capacity };
    this.sessions = new ManagedSessions(
      this.store,
      this.artifacts,
      this.now,
      () => !this.closing && !this.stopped,
    );
    this.validateTiming();
    this.calls = new BoundedHostCalls(options.launchTimeoutMs ?? 30_000);
    this.creationWaits = new CreationWaits((id) => this.get(id), options.launchTimeoutMs ?? 30_000);
    this.opened = this.open();
    void this.opened.catch(() => {});
    this.detach = host.onAttach(() => {
      void this.recover().catch((error: unknown) =>
        console.error("paseo-bots: coordinator recovery failed", error),
      );
    });
  }

  private async open(): Promise<void> {
    await this.lock.acquire();
    try {
      await this.store.backfillManagedAgentClaims();
    } catch (error) {
      await this.lock.release();
      throw error;
    }
  }

  private validateTiming(): void {
    for (const value of [this.options.launchTimeoutMs ?? 30_000, this.options.reconcileIntervalMs ?? 30_000])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Coordinator timing limits must be positive safe integers.");
  }

  get readiness(): HostReadiness {
    return this.state;
  }

  private async serial<T>(work: () => Promise<T>, draining = false): Promise<T> {
    await this.opened;
    if (this.stopped || (this.closing && !draining))
      throw new Error("Run coordinator is stopped or stopping.");
    const next = this.queue.then(() => {
      if (this.stopped || (this.closing && !draining))
        throw new Error("Run coordinator is stopped or stopping.");
      return work();
    });
    this.queue = next.catch(() => {});
    void next.then(
      () => this.creationWaits.signal(),
      () => this.creationWaits.signal(),
    );
    return next;
  }

  stopLaunching(): void {
    this.calls.close();
  }

  async stop(): Promise<void> {
    this.closing = true;
    clearTimeout(this.wake);
    clearInterval(this.periodic);
    this.stopLaunching();
    await this.observing;
    this.detach();
    await Promise.allSettled([this.recovery]);
    await this.queue;
    await Promise.allSettled(this.launches.values());
    await this.queue;
    await this.creationWaits.close();
    this.stopped = true;
    this.state = "stopped";
    // Bootstrap failure already reached every caller through `opened`; cleanup must still finish.
    // release() is a no-op without ownership and token-checked otherwise, so a foreign lock is never removed.
    await this.opened.catch(() => undefined);
    await this.lock.release();
  }

  async admit(input: Admission): Promise<RoutineRun> {
    const request = this.admissionRequest(input);
    const key = requestKey(request);
    const prior = await this.findRequest(request);
    if (prior) {
      await this.recovery;
      await this.pump();
      return (await this.get(prior.id)) ?? prior;
    }
    input = this.captureAdmission(input, request.requestHash);
    this.validateDeadline(input.deadlineAt);
    const identity = admitRun({
      routineId: input.routine?.id ?? `chat:${input.bot.id}`,
      trigger: input.trigger,
      due: input.due,
      now: new Date(this.now()),
      epoch: SessionEpochSchema.parse(1),
    });
    identity.occurrenceKey = key;
    if (input.deadlineAt !== undefined && input.deadlineAt <= this.now())
      return this.rejectAdmission(input, identity, "Execution deadline expired before preparation.");
    this.host.requirePaseo();
    const agentId = newUuid();
    let prepared: PreparedBotChat;
    try {
      prepared = await this.calls.run(
        () =>
          (this.options.prepare ?? prepareChat)(this.host, this.relay, input.bot, {
            agentId,
            idempotencyKey: identity.executionId,
            prompt: input.prompt,
            title: input.title,
            routineId: input.routine?.id,
            purpose: input.purpose,
            state: input.state,
            labels: {
              ...input.labels,
              [RUN_LABEL]: identity.id,
              [EXECUTION_LABEL]: identity.executionId,
              [OCCURRENCE_LABEL]: key,
            },
          }),
        "Managed preparation",
      );
    } catch (error) {
      return this.rejectAdmission(input, identity, errorText(error));
    }
    return this.admitPrepared(
      prepared,
      {
        ...input,
        routineId: input.routine?.id,
        capacity: input.routine?.runtime?.capacity,
        overlap: input.overlap ?? input.routine?.runtime?.overlap,
        resourceIds: input.resourceIds ?? input.routine?.runtime?.resourceIds,
      },
      identity,
    );
  }

  private captureAdmission(input: Admission, requestHash: string): Admission {
    const state = copy(input.state);
    const bot = state.bots.find((entry) => entry.id === input.bot.id);
    if (bot?.executionMode !== "managed")
      throw new Error("Managed admission requires an explicitly managed bot in the captured state.");
    if (bot.hostId)
      throw new Error("Remote managed execution is unsupported; use the visibly legacy manual path.");
    const routine = input.routine ? bot.routines.find((entry) => entry.id === input.routine?.id) : undefined;
    if (input.routine && !routine)
      throw new Error("The routine is absent from the captured admission state.");
    return { ...input, state, bot, routine, requestHash };
  }

  private rejectAdmission(input: Admission, run: RoutineRun, error: string): Promise<RoutineRun> {
    return this.serial(() =>
      this.store.updateState((state) => this.recordRejection(state, run, { input, error })),
    );
  }

  private recordRejection(
    state: RunSnapshot,
    run: RoutineRun,
    { input, error }: { input: Admission; error: string },
  ): RoutineRun {
    const request = this.admissionRequest(input);
    const existing = existingRequest(state, run.occurrenceKey, request.requestHash);
    if (existing) return copy(existing);
    run.executionStatus = "failed";
    run.taskOutcome = "unknown";
    run.agentCreationStatus = "not_created";
    run.error = error;
    if (input.deadlineAt !== undefined && input.deadlineAt <= this.now()) run.executionStatus = "canceled";
    run.endedAt = new Date(this.now()).toISOString();
    const id = input.routine?.id ?? `chat:${input.bot.id}`;
    const record = state.routines[id] ?? emptyRecord();
    if (run.trigger === "schedule") record.lastRunAt = run.scheduledFor;
    appendRun(record, run);
    state.routines[id] = record;
    rememberRequest(state, request, run);
    return copy(run);
  }

  private admissionRequest(input: Admission): ReplayRequest {
    return {
      botId: input.bot.id,
      routineId: input.routine?.id,
      trigger: input.trigger,
      due: input.due,
      requestId: input.requestId,
      requestHash:
        input.requestHash ??
        requestHashOf({
          botId: input.bot.id,
          routineId: input.routine?.id,
          trigger: input.trigger,
          requestId: input.trigger === "schedule" ? undefined : input.requestId,
          prompt: input.prompt,
          title: input.title,
          purpose: input.purpose,
          labels: input.labels,
          resourceIds: input.resourceIds,
          overlap: input.overlap,
          deferLaunch: input.deferLaunch,
          deadlineAt: input.deadlineAt,
        }),
    };
  }

  findRequest(input: ReplayRequest): Promise<RoutineRun | null> {
    return this.serial(async () =>
      copy(existingRequest(await this.store.read(), requestKey(input), input.requestHash)),
    );
  }

  private validateDeadline(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error("deadlineAt must be a nonnegative safe epoch-millisecond instant.");
  }

  async admitPrepared(
    prepared: PreparedBotChat,
    input: PreparedAdmission,
    identity?: RoutineRun,
  ): Promise<RoutineRun> {
    if (this.closing) throw new Error("Run coordinator is stopping.");
    this.validateDeadline(input.deadlineAt);
    input = {
      ...input,
      requestHash:
        input.requestHash ??
        requestHashOf({
          botId: prepared.botId,
          routineId: input.routineId,
          trigger: input.trigger,
          requestId: input.trigger === "schedule" ? undefined : input.requestId,
          prompt: prepared.prompt,
          title: prepared.title,
          purpose: prepared.purpose,
          labels: prepared.labels,
          resourceIds: input.resourceIds,
          overlap: input.overlap,
          deferLaunch: input.deferLaunch,
          deadlineAt: input.deadlineAt,
        }),
    };
    const admitted = await this.serial(async () => {
      const run =
        identity ??
        admitRun({
          routineId: input.routineId ?? `chat:${prepared.botId}`,
          trigger: input.trigger,
          due: input.due,
          now: new Date(this.now()),
          epoch: SessionEpochSchema.parse(1),
        });
      const recordId = input.routineId ?? `chat:${prepared.botId}`;
      run.occurrenceKey = requestKey({ ...input, botId: prepared.botId });
      const saved = await this.store.read();
      const existing = existingRequest(saved, run.occurrenceKey, input.requestHash ?? "");
      if (existing) return copy(existing);
      await this.validatePreparedMode(prepared, input);
      this.validateAgentIdentity(saved, prepared.agentId);
      await this.store.initialize();
      const frozen = this.freezePrepared(prepared, run);
      const artifact = await this.artifacts.put({ prepared: frozen, capacity: input.capacity ?? {} });
      this.initialize(run, frozen, input, artifact);
      await this.store.updateState((state) => {
        this.validateAgentOwnership(state, frozen.agentId);
        this.recordAdmission(state, recordId, run);
      });
      return copy(run);
    });
    await this.recovery;
    await this.pump();
    return (await this.get(admitted.id)) ?? admitted;
  }

  private async validatePreparedMode(prepared: PreparedBotChat, input: PreparedAdmission): Promise<void> {
    const bot = (input.state?.bots ?? (await this.host.bots())).find((entry) => entry.id === prepared.botId);
    if (bot?.executionMode !== "managed")
      throw new Error("Prepared managed admission requires explicit local managed execution mode.");
    if (prepared.hostId || bot.hostId) throw new Error("Remote managed execution is unsupported.");
  }

  private freezePrepared(prepared: PreparedBotChat, run: RoutineRun): PreparedBotChat {
    const frozen = copy(prepared);
    frozen.labels = {
      ...frozen.labels,
      [RUN_LABEL]: run.id,
      [EXECUTION_LABEL]: run.executionId,
      [OCCURRENCE_LABEL]: run.occurrenceKey,
    };
    frozen.clientMessageId ??= run.executionId;
    frozen.metadata.systemPromptHash = createHash("sha256").update(frozen.config.systemPrompt).digest("hex");
    frozen.metadata.userPromptHash = createHash("sha256").update(frozen.prompt).digest("hex");
    if (!frozen.hostId)
      frozen.metadata.environmentVersion ??= `paseo-bots/${PLUGIN_VERSION};${controllerRuntimeVersion()};${process.platform}/${process.arch}`;
    return frozen;
  }

  private validateAgentIdentity(state: RunSnapshot, agentId: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId))
      throw new Error("Managed agent identity must be an RFC 4122 v4 UUID.");
    this.validateAgentOwnership(state, agentId);
  }

  private validateAgentOwnership(state: RunSnapshot, agentId: string, ownerRunId?: string): void {
    if (
      allRuns(state).some(
        (entry) =>
          entry.id !== ownerRunId &&
          (entry.agentId === agentId ||
            entry.managed?.attempts.some((attempt) => attempt.agentId === agentId)),
      )
    )
      throw new Error("This agent identity is already admitted; a different occurrence requires a new UUID.");
  }

  private initialize(
    run: RoutineRun,
    prepared: PreparedBotChat,
    input: PreparedAdmission,
    artifact: { id: string; sha256: string },
  ): void {
    run.agentId = prepared.agentId;
    run.purpose = prepared.purpose;
    run.executionStatus = "queued";
    run.agentCreationStatus = "not_created";
    run.managed = {
      botId: prepared.botId,
      routineId: input.routineId ?? null,
      requestId: input.requestId,
      artifact,
      provider: prepared.provider,
      model: prepared.model,
      systemPromptHash: prepared.metadata.systemPromptHash,
      userPromptHash: prepared.metadata.userPromptHash,
      environmentVersion: prepared.metadata.environmentVersion,
      clientMessageId: prepared.clientMessageId ?? run.executionId,
      resourceIds: [...new Set(input.resourceIds ?? [])],
      overlap: input.overlap ?? "skip",
      reservation: false,
      overlapLimit: input.overlap === undefined && input.trigger === "webhook" ? 3 : 1,
      notBefore: this.now(),
      attempts: [],
      timeline: null,
      creation: null,
      cancelRequested: false,
      coalescedInto: null,
      requestHash: input.requestHash,
      launchIntent: !input.deferLaunch,
      deadlineAt: input.deadlineAt ?? null,
      firstReservedAt: null,
      maxRunSeconds: prepared.metadata.resolvedPolicy.budget.maxRunSeconds.value,
    };
    run.managed.attempts.push(this.attempt(run, prepared));
  }

  private attempt(run: RoutineRun, prepared: PreparedBotChat) {
    return {
      attemptId: run.attemptId,
      executionId: run.executionId,
      agentId: prepared.agentId,
      idempotencyKey: prepared.idempotencyKey,
      number: (run.managed?.attempts.length ?? 0) + 1,
      state: "reserved" as const,
      error: null,
    };
  }

  private recordAdmission(state: RunSnapshot, recordId: string, run: RoutineRun): void {
    const managed = run.managed;
    if (!managed) throw new Error("Missing admission metadata.");
    const record = state.routines[recordId] ?? emptyRecord();
    state.routines[recordId] = record;
    const active = record.runs.some(
      (entry) =>
        holds(entry) ||
        (!entry.managed && (!isTerminal(entry.executionStatus) || entry.executionStatus === "unknown")),
    );
    const queued = record.runs.find((entry) => entry.executionStatus === "queued");
    const webhookRoom = this.webhookRoom(record, managed.overlapLimit);
    const decision = webhookRoom ? "admit" : overlapDecision(managed.overlap, active, !!queued);
    if (decision === "skip" || decision === "coalesce") {
      this.recordBusy(run, decision === "coalesce" ? queued : undefined);
    }
    if (run.trigger === "schedule") record.lastRunAt = run.scheduledFor;
    managed.admissionOrder = ++state.coordinator.admissionOrder;
    managed.admittedAt = this.now();
    rememberRequest(
      state,
      {
        botId: managed.botId,
        routineId: managed.routineId ?? undefined,
        trigger: run.trigger,
        due: new Date(run.scheduledFor),
        requestId: managed.requestId,
        requestHash: managed.requestHash ?? "",
      },
      run,
    );
    state.coordinator.occurrences[run.occurrenceKey] = run.id;
    appendRun(record, run);
  }

  private recordBusy(run: RoutineRun, coalesced: RoutineRun | undefined): void {
    if (!run.managed) throw new Error("Missing managed overlap metadata.");
    run.executionStatus = "canceled";
    run.taskOutcome = "unknown";
    run.agentCreationStatus = "not_created";
    run.skipped = "busy";
    run.endedAt = new Date(this.now()).toISOString();
    run.managed.coalescedInto = coalesced?.id ?? null;
  }

  private webhookRoom(record: RoutineRecord, limit: number): boolean {
    if (
      record.runs.some(
        (entry) =>
          !entry.managed && (!isTerminal(entry.executionStatus) || entry.executionStatus === "unknown"),
      )
    )
      return false;
    return (
      limit > 1 &&
      record.runs.filter((entry) => holds(entry) || entry.executionStatus === "queued").length < limit
    );
  }

  async recordMissed(routineId: string, due: Date, now: Date): Promise<RoutineRun> {
    return this.serial(() =>
      this.store.updateState((state) => {
        const run = admitRun({
          routineId,
          trigger: "schedule",
          due,
          now,
          epoch: SessionEpochSchema.parse(0),
        });
        const prior = state.coordinator.occurrences[run.occurrenceKey];
        const existing = prior ? lookup(state, prior) : null;
        if (existing) return copy(existing);
        if (prior) throw new Error("Missed occurrence already recorded; replay refused.");
        run.executionStatus = "canceled";
        run.taskOutcome = "unknown";
        run.agentCreationStatus = "not_created";
        run.skipped = "missed";
        run.endedAt = now.toISOString();
        const record = state.routines[routineId] ?? emptyRecord();
        record.lastRunAt = due.toISOString();
        appendRun(record, run);
        state.routines[routineId] = record;
        state.coordinator.occurrences[run.occurrenceKey] = run.id;
        return copy(run);
      }),
    );
  }

  async startPrepared(planId: string): Promise<RoutineRun> {
    const admitted = await this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, planId);
        if (!run?.managed) throw new Error("Managed execution plan not found.");
        if (run.executionStatus === "canceled") return copy(run);
        if (!isTerminal(run.executionStatus) && !expireBeforeLaunch(run, this.now()))
          run.managed.launchIntent = true;
        return copy(run);
      }),
    );
    await this.recovery;
    await this.pump();
    return (await this.get(planId)) ?? admitted;
  }

  async snapshot(
    runId: string,
  ): Promise<
    { status: "available"; metadata: PreparedChatMetadata } | { status: "unavailable"; reason: string }
  > {
    const run = await this.get(runId);
    if (!run?.managed)
      return {
        status: "unavailable",
        reason: "This legacy or missing run has no immutable managed admission snapshot.",
      };
    try {
      const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
      return { status: "available", metadata: copy(artifact.prepared.metadata) };
    } catch (error) {
      return {
        status: "unavailable",
        reason: `The retained admission artifact cannot be verified: ${errorText(error)}`,
      };
    }
  }

  isManagedAgent(agentId: string): Promise<boolean> {
    return this.store.isManagedAgent(agentId);
  }

  async sessionOpened(input: ManagedSessionOpening): Promise<ManagedSessionReceipt | null> {
    if (input.purpose === "history") return null;
    const receipt = await this.serial(() => this.sessions.opened(input));
    if (this.closing) throw new Error("Managed coordinator is stopping.");
    return receipt;
  }

  async sessionActive(agentId: string): Promise<void> {
    await this.serial(() => this.sessions.active(agentId));
    this.creationWaits.signal();
  }

  recordLegacy(
    input: LegacyAdmission,
    initialize?: (record: RoutineRecord, run: RoutineRun) => void,
  ): Promise<{ run: RoutineRun; created: boolean }> {
    return this.serial(() =>
      this.store.updateState((state) => {
        const existing = existingRequest(state, requestKey(input), input.requestHash);
        if (existing) return { run: copy(existing), created: false };
        const run = admitRun({ ...input, now: new Date(this.now()), epoch: SessionEpochSchema.parse(0) });
        run.occurrenceKey = requestKey(input);
        run.executionStatus = "starting";
        const record = state.routines[input.routineId] ?? emptyRecord();
        initialize?.(record, run);
        if (run.agentId) this.validateAgentOwnership(state, run.agentId);
        if (input.trigger === "schedule") record.lastRunAt = run.scheduledFor;
        appendRun(record, run);
        state.routines[input.routineId] = record;
        rememberRequest(state, input, run);
        return { run: copy(run), created: true };
      }),
    );
  }

  finishLegacy(runId: string, patch: Partial<RoutineRun>): Promise<RoutineRun> {
    return this.serial(() => this.store.updateState((state) => this.patchLegacy(state, runId, patch)));
  }

  private patchLegacy(state: RunSnapshot, runId: string, patch: Partial<RoutineRun>): RoutineRun {
    const run = lookup(state, runId);
    if (!run || run.managed) throw new Error("Legacy run not found.");
    this.assignLegacyIdentity(state, run, patch.agentId);
    const creation = run.agentCreationStatus;
    if (isTerminal(run.executionStatus)) {
      if (patch.agentCreationStatus === "created") run.agentCreationStatus = "created";
    } else Object.assign(run, patch);
    if (creation === "created") run.agentCreationStatus = "created";
    return copy(run);
  }

  private assignLegacyIdentity(
    state: RunSnapshot,
    run: RoutineRun,
    agentId: RoutineRun["agentId"] | undefined,
  ): void {
    if (agentId === undefined) return;
    if (run.agentId && agentId !== run.agentId)
      throw new Error("An admitted legacy agent identity cannot be replaced or cleared.");
    if (agentId) this.validateAgentOwnership(state, agentId, run.id);
    run.agentId = agentId;
  }

  async get(id: string): Promise<RoutineRun | null> {
    await this.opened;
    return copy(await this.store.get(id));
  }

  async list(
    filter: RunFilter = {},
  ): Promise<{ runs: RoutineRun[]; cursor: string | null; readiness: HostReadiness }> {
    await this.opened;
    const page = await this.store.list(filter);
    return { runs: page.runs, cursor: page.nextCursor, readiness: this.state };
  }

  async pump(): Promise<void> {
    if (this.stopped || this.closing || this.state === "reconciling") return;
    await this.enforceActiveDeadlines();
    const admitted = await this.serial(() => this.store.updateState((state) => this.selectLaunches(state)));
    for (const id of admitted)
      void this.launch(id).catch((error: unknown) =>
        console.error("paseo-bots: managed launch failed", error),
      );
    await this.armWake();
  }

  private async selectLaunches(state: RunSnapshot): Promise<string[]> {
    const all = allRuns(state);
    const pending = all.filter((run) => run.managed && ["queued", "reserved"].includes(run.executionStatus));
    for (const run of pending) expireBeforeLaunch(run, this.now());
    const active = all.filter(holds);
    pending.sort(
      (a, b) =>
        (a.managed?.admissionOrder ?? Date.parse(a.startedAt)) -
        (b.managed?.admissionOrder ?? Date.parse(b.startedAt)),
    );
    const selected: string[] = [];
    for (const run of pending) {
      if (!this.canStart(run) || expireBeforeLaunch(run, this.now())) continue;
      if (run.executionStatus !== "reserved") {
        if (!(await this.reserve(state, run, active))) continue;
        active.push(run);
      }
      selected.push(run.id);
    }
    return selected;
  }

  private canStart(run: RoutineRun): boolean {
    return (
      !this.closing &&
      !!this.host.paseo &&
      !run.managed?.cancelRequested &&
      run.managed?.launchIntent !== false &&
      !isTerminal(run.executionStatus)
    );
  }

  private async armWake(): Promise<void> {
    clearTimeout(this.wake);
    if (this.closing) return;
    const state = await this.store.read();
    const times = allRuns(state)
      .flatMap((run) => {
        if (!run.managed) return [];
        const deadline = deadlineOf(run);
        const deadlines =
          Number.isFinite(deadline) && (!isTerminal(run.executionStatus) || holds(run)) ? [deadline] : [];
        if (run.executionStatus !== "queued" || run.managed.launchIntent === false) return deadlines;
        const circuit = state.coordinator.circuits[run.managed.provider];
        return [...deadlines, Math.max(run.managed.notBefore, circuit?.openUntil ?? 0)];
      })
      .filter((at) => at > this.now());
    if (times.length === 0) return;
    this.wake = setTimeout(
      () => {
        void this.pump().catch((error: unknown) =>
          console.error("paseo-bots: coordinator wake failed", error),
        );
      },
      Math.min(2_147_483_647, Math.min(...times) - this.now()),
    );
    this.wake.unref?.();
  }

  private async reserve(state: RunSnapshot, run: RoutineRun, active: RoutineRun[]): Promise<boolean> {
    const managed = run.managed;
    if (
      !managed ||
      managed.launchIntent === false ||
      managed.cancelRequested ||
      run.executionStatus !== "queued" ||
      managed.notBefore > this.now()
    )
      return false;
    active = active.filter(holds);
    const sameRoutine = active.filter(
      (entry) => entry.managed?.routineId === managed.routineId && managed.routineId !== null,
    );
    if (sameRoutine.length >= managed.overlapLimit) return false;
    const legacySameRoutine = managed.routineId
      ? state.routines[managed.routineId]?.runs.some(
          (entry) => entry.id !== run.id && !entry.managed && !isTerminal(entry.executionStatus),
        )
      : false;
    if (legacySameRoutine) return false;
    const artifact = await this.artifacts.get<{
      prepared: PreparedBotChat;
      capacity: Partial<CapacityLimits>;
    }>(managed.artifact);
    const limits = this.capacityFor(artifact);
    const reservations = active.map((entry) => ({
      provider: entry.managed?.provider ?? "unknown",
      botId: entry.managed?.botId ?? "unknown",
      resourceIds: entry.managed?.resourceIds ?? [],
    }));
    if (capacityBlock(managed, reservations, limits)) return false;
    const circuit = providerCircuitDecision(
      state.coordinator.circuits[managed.provider] ?? providerCircuitSuccess(),
      this.now(),
    );
    if (!circuit.allowed) return false;
    state.coordinator.circuits[managed.provider] = circuit.state;
    managed.reservation = true;
    run.executionStatus = "reserved";
    managed.firstReservedAt ??= this.now();
    return true;
  }

  private capacityFor(artifact: {
    prepared: PreparedBotChat;
    capacity: Partial<CapacityLimits>;
  }): CapacityLimits {
    return {
      global: Math.min(this.capacity.global, artifact.capacity.global ?? Infinity),
      perProvider: Math.min(this.capacity.perProvider, artifact.capacity.perProvider ?? Infinity),
      perBot: Math.min(
        this.capacity.perBot,
        artifact.capacity.perBot ?? Infinity,
        artifact.prepared.metadata.resolvedPolicy.concurrency.maxConcurrentRuns.value ?? Infinity,
      ),
      perResource: Math.min(this.capacity.perResource, artifact.capacity.perResource ?? Infinity),
    };
  }

  private launch(id: string): Promise<void> {
    const existing = this.launches.get(id);
    if (existing) return existing;
    const pending = this.launchOne(id).finally(() => this.launches.delete(id));
    this.launches.set(id, pending);
    return pending;
  }

  private async launchOne(id: string): Promise<void> {
    const prepared = await this.serial(() => this.store.updateState((state) => this.beginLaunch(state, id)));
    if (!prepared || this.closing) return;
    let evidence: CreationEvidence | null = null;
    let created = false;
    try {
      const agentId = await this.calls.run(
        (signal) =>
          (this.options.launch ?? launchPreparedChat)(this.host, this.relay, prepared, {
            signal,
            onEvent: (value) => {
              evidence = value;
              created ||= this.isCreationAck(prepared.agentId, value);
            },
          }),
        "Managed agent creation",
      );
      if (agentId !== prepared.agentId)
        throw new Error("Host did not preserve the admitted agent identity; reconcile required.");
      await this.launched(id, evidence, prepared.labels[EXECUTION_LABEL]);
    } catch (error) {
      await this.launchFailed(id, prepared.labels[EXECUTION_LABEL], { error, evidence, created });
    }
  }

  private async beginLaunch(state: RunSnapshot, id: string): Promise<PreparedBotChat | null> {
    const run = lookup(state, id);
    if (!run?.managed || run.executionStatus !== "reserved") return null;
    if (!this.canStart(run) || expireBeforeLaunch(run, this.now())) return null;
    const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
    if (this.closing) return null;
    if (run.agentCreationStatus !== "created") run.agentCreationStatus = "unknown";
    run.executionStatus = "starting";
    this.setAttempt(run, "starting");
    return artifact.prepared;
  }

  private async launched(
    id: string,
    evidence: CreationEvidence | null,
    executionId: string | undefined,
  ): Promise<void> {
    await this.serial(
      () => this.store.updateState((state) => this.recordLaunched(state, id, evidence, executionId)),
      true,
    );
  }

  private recordLaunched(
    state: RunSnapshot,
    id: string,
    evidence: CreationEvidence | null,
    executionId: string | undefined,
  ): void {
    const run = lookup(state, id);
    if (!run?.managed || run.executionId !== executionId) return;
    run.managed.hostCreatedAt ??= this.now();
    run.agentCreationStatus = "created";
    this.creation(run, evidence);
    if (run.executionStatus === "starting") {
      run.executionStatus = evidence?.outcomeUnknown ? "unknown" : "running";
      this.setAttempt(run, run.executionStatus);
    }
    if (!evidence?.outcomeUnknown)
      state.coordinator.circuits[run.managed.provider] = providerCircuitSuccess();
  }

  private creation(run: RoutineRun, evidence: CreationEvidence | null): void {
    if (!run.managed || !evidence) return;
    if (run.agentId && this.isCreationAck(run.agentId, evidence)) {
      run.agentCreationStatus = "created";
      run.managed.hostCreatedAt ??= this.now();
    }
    run.managed.creation = {
      key: evidence.idempotencyKey,
      revision: evidence.revision,
      phase: evidence.phase,
      outcomeUnknown: evidence.outcomeUnknown ?? false,
    };
  }

  private isCreationAck(agentId: string, evidence: CreationEvidence): boolean {
    return (
      evidence.kind === "agent" &&
      evidence.agentId === agentId &&
      ["agent_ready", "prompt_started", "completed"].includes(evidence.phase)
    );
  }

  private setAttempt(
    run: RoutineRun,
    status: "starting" | "running" | "failed" | "completed" | "canceled" | "unknown",
  ): void {
    const attempt = run.managed?.attempts.at(-1);
    if (attempt) {
      attempt.state = status;
      attempt.error = run.error;
    }
  }

  private async launchFailed(
    id: string,
    executionId: string | undefined,
    failure: LaunchFailure,
  ): Promise<void> {
    await this.serial(
      () => this.store.updateState((state) => this.applyLaunchFailure(state, id, executionId, failure)),
      true,
    );
  }

  private async applyLaunchFailure(
    state: RunSnapshot,
    id: string,
    executionId: string | undefined,
    { error, evidence, created }: LaunchFailure,
  ): Promise<void> {
    const run = lookup(state, id);
    if (!run?.managed || run.executionStatus !== "starting" || run.executionId !== executionId) return;
    if (created) {
      run.agentCreationStatus = "created";
      run.managed.hostCreatedAt ??= this.now();
    }
    this.creation(run, evidence);
    run.error = errorText(error);
    if (run.agentCreationStatus !== "created" && this.provenNoCreate(error, evidence)) {
      this.noCreateFailure(run);
      return;
    }
    if (!this.retryable(run, error, evidence)) {
      run.executionStatus = "unknown";
      this.setAttempt(run, "unknown");
      return;
    }
    await this.safeFailure(state, run, error);
  }

  private provenNoCreate(error: unknown, evidence: CreationEvidence | null): boolean {
    return (
      (error instanceof HostCapabilityError ||
        error instanceof PreparedLaunchNotCreatedError ||
        error instanceof HostCallNotDispatchedError) &&
      !evidence?.outcomeUnknown
    );
  }

  private noCreateFailure(run: RoutineRun): void {
    if (!run.managed) throw new Error("Missing managed no-create evidence.");
    const status = run.managed.cancelRequested ? "canceled" : "failed";
    run.executionStatus = status;
    run.taskOutcome = "unknown";
    run.agentCreationStatus = "not_created";
    run.endedAt = new Date(this.now()).toISOString();
    run.managed.reservation = false;
    run.managed.launchIntent = false;
    run.managed.cancelError = null;
    this.setAttempt(run, status);
  }

  private retryable(
    run: RoutineRun,
    error: unknown,
    evidence: CreationEvidence | null,
  ): error is ProvenInfrastructureError {
    return (
      error instanceof ProvenInfrastructureError &&
      error.provider === run.managed?.provider &&
      !evidence?.outcomeUnknown
    );
  }

  private async safeFailure(
    state: RunSnapshot,
    run: RoutineRun,
    error: ProvenInfrastructureError,
  ): Promise<void> {
    const managed = run.managed;
    if (!managed) return;
    if (managed.cancelRequested) {
      run.executionStatus = "canceled";
      run.taskOutcome = "unknown";
      run.endedAt = new Date(this.now()).toISOString();
      managed.reservation = false;
      managed.launchIntent = false;
      managed.cancelError = null;
      this.setAttempt(run, "canceled");
      return;
    }
    this.setAttempt(run, "failed");
    managed.reservation = false;
    state.coordinator.circuits[managed.provider] = providerCircuitFailure(
      state.coordinator.circuits[managed.provider] ?? providerCircuitSuccess(),
      this.now(),
    );
    const next = retryDelay({
      attempt: managed.attempts.length,
      now: this.now(),
      retryAfterMs: error.retryAfterMs,
      jitter: this.jitter,
    });
    if (next === null || next >= deadlineOf(run)) {
      run.executionStatus = "failed";
      run.taskOutcome = "unknown";
      run.endedAt = new Date(this.now()).toISOString();
      return;
    }
    const artifact = await this.artifacts.get<{
      prepared: PreparedBotChat;
      capacity: Partial<CapacityLimits>;
    }>(managed.artifact);
    run.attemptId = newAttemptId();
    run.executionId = newExecutionId();
    run.sessionEpoch = SessionEpochSchema.parse(1);
    const agentId = newUuid();
    this.validateAgentIdentity(state, agentId);
    run.agentId = agentId;
    run.agentCreationStatus = "not_created";
    delete managed.hostCreatedAt;
    delete managed.evidence;
    delete managed.result;
    artifact.prepared.agentId = run.agentId;
    artifact.prepared.idempotencyKey = run.executionId;
    artifact.prepared.clientMessageId = run.executionId;
    managed.clientMessageId = run.executionId;
    artifact.prepared.labels[EXECUTION_LABEL] = run.executionId;
    managed.artifact = await this.artifacts.put(artifact);
    managed.notBefore = next;
    managed.creation = null;
    managed.timeline = null;
    run.executionStatus = "queued";
    managed.attempts.push(this.attempt(run, artifact.prepared));
  }

  waitForCreation(runId: string, options: { timeoutMs?: number } = {}): Promise<CreationWaitResult> {
    return this.creationWaits.wait(runId, options);
  }

  async finished(agentId: string, input: ExecutionEnd): Promise<RoutineRun | null> {
    if (input.sessionEpoch !== undefined) SessionEpochSchema.parse(input.sessionEpoch);
    const run = await this.serial(() =>
      this.store.updateState((state) => this.settleExecution(state, agentId, input)),
    );
    if (!run) return null;
    if (input.sessionEpoch === undefined) await this.reconcile(run.id);
    await this.pump();
    return (await this.get(run.id)) ?? run;
  }

  private async settleExecution(
    state: RunSnapshot,
    agentId: string,
    input: ExecutionEnd,
  ): Promise<RoutineRun | null> {
    const run = allRuns(state).find((entry) => entry.agentId === agentId && holds(entry));
    if (!run?.managed || (input.executionId && run.executionId !== input.executionId)) return null;
    if (input.routineId && run.managed.routineId !== input.routineId) return null;
    if (input.sessionEpoch !== undefined && input.sessionEpoch !== run.sessionEpoch) return null;
    const artifact = await this.retainLifecycle(run, input);
    if (input.sessionEpoch === undefined) {
      run.executionStatus = "unknown";
      run.error =
        "Completion has no authenticated provider-session generation; fresh current-session evidence is required.";
      this.setAttempt(run, "unknown");
    } else this.applyCompletion(run, input, artifact);
    return copy(run);
  }

  private async retainLifecycle(run: RoutineRun, input: ExecutionEnd) {
    if (!run.managed) throw new Error("Missing managed lifecycle evidence.");
    const observedAt = this.now();
    const artifact = await this.artifacts.put({
      version: 1,
      runId: run.id,
      executionId: run.executionId,
      attemptId: run.attemptId,
      sessionEpoch: input.sessionEpoch ?? null,
      source: "lifecycle",
      kind: input.kind,
      reply: input.reply ?? null,
      providerTurnId: input.turnId ?? null,
      observedAt,
    });
    run.managed.evidence = {
      artifact,
      source: "lifecycle",
      replyComplete: input.sessionEpoch !== undefined && input.reply !== undefined,
      timelineComplete: false,
      observedAt,
    };
    run.managed.hostCreatedAt ??= observedAt;
    run.agentCreationStatus = "created";
    return artifact;
  }

  private applyCompletion(
    run: RoutineRun,
    input: ExecutionEnd,
    artifact: { id: string; sha256: string },
  ): void {
    if (!run.managed) throw new Error("Missing managed completion.");
    run.managed.result = artifact;
    run.executionStatus = input.kind;
    run.providerTurnId = providerTurnId(input.turnId);
    run.taskOutcome = "unknown";
    run.endedAt = new Date(this.now()).toISOString();
    run.output = input.reply?.trim().slice(0, 400) || null;
    run.error = input.error ?? null;
    run.managed.reservation = false;
    this.setAttempt(run, input.kind);
  }

  private cancelBeforeLaunch(run: RoutineRun): void {
    if (!run.managed) throw new Error("Missing managed cancellation.");
    run.executionStatus = "canceled";
    run.taskOutcome = "unknown";
    if (run.agentCreationStatus !== "created" && run.managed.hostCreatedAt === undefined)
      run.agentCreationStatus = "not_created";
    run.endedAt = new Date(this.now()).toISOString();
    run.managed.reservation = false;
    run.managed.launchIntent = false;
    this.setAttempt(run, "canceled");
  }

  async cancel(id: string): Promise<{ run: RoutineRun; error: string | null }> {
    const result = await this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, id);
        if (!run) throw new Error("Run not found.");
        if (!run.managed) throw new Error("Legacy runs require manual host reconciliation.");
        const alreadyRequested = run.managed.cancelRequested;
        run.managed.cancelRequested = true;
        const beforeLaunch = run.executionStatus === "queued" || run.executionStatus === "reserved";
        if (beforeLaunch) this.cancelBeforeLaunch(run);
        return { run: copy(run), beforeLaunch, alreadyRequested };
      }),
    );
    if (result.beforeLaunch || !holds(result.run)) return { run: result.run, error: null };
    if (result.alreadyRequested) return { run: result.run, error: result.run.managed?.cancelError ?? null };
    let error: string | null = null;
    const cancelAdapter = this.options.cancel;
    if (!cancelAdapter)
      error =
        "The attached Paseo API does not expose active cancellation. Stop the agent in Paseo, then reconcile; capacity remains reserved.";
    else {
      try {
        await this.calls.run(
          () => cancelAdapter(result.run.agentId ?? ""),
          "Managed cancellation acknowledgement",
        );
      } catch (failure) {
        error = errorText(failure);
      }
    }
    await this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, id);
        if (run?.managed) run.managed.cancelError = error;
      }),
    );
    return { run: (await this.get(id)) ?? result.run, error };
  }

  async ready(): Promise<void> {
    await this.opened;
    await this.recovery;
  }

  recover(): Promise<void> {
    if (this.recovery) return this.recovery;
    if (!this.host.paseo || this.stopped || this.closing) return Promise.resolve();
    this.state = "reconciling";
    this.recovery = this.reconcile()
      .then(() => {
        if (!this.closing) this.state = "ready";
      })
      .finally(() => {
        this.recovery = null;
      });
    return this.recovery.then(() => {
      this.armPeriodic();
      return this.pump();
    });
  }

  private armPeriodic(): void {
    if (this.periodic || this.closing) return;
    this.periodic = setInterval(() => {
      if (this.observing || this.closing) return;
      this.observing = this.observe()
        .catch((error: unknown) => console.error("paseo-bots: periodic reconciliation failed", error))
        .finally(() => {
          this.observing = null;
        });
    }, this.options.reconcileIntervalMs ?? 30_000);
    this.periodic.unref?.();
  }

  private async observe(): Promise<void> {
    await this.enforceActiveDeadlines();
    await this.reconcile();
    await this.pump();
  }

  private async enforceActiveDeadlines(): Promise<void> {
    const state = await this.store.read();
    const expired = allRuns(state).filter(
      (run) =>
        holds(run) &&
        !run.managed?.cancelRequested &&
        !["queued", "reserved"].includes(run.executionStatus) &&
        this.now() >= deadlineOf(run),
    );
    await Promise.all(expired.map((run) => this.cancel(run.id)));
  }

  async reconcile(id?: string): Promise<{ runs: RoutineRun[]; readiness: HostReadiness }> {
    const candidates = await this.serial(async () =>
      allRuns(await this.store.read())
        .filter(
          (run) =>
            (!id || run.id === id) &&
            holds(run) &&
            run.executionStatus !== "queued" &&
            !this.launches.has(run.id),
        )
        .map(copy),
    );
    await Promise.all(candidates.map((run) => this.reconcileOne(run)));
    const runs = id
      ? [await this.get(id)].filter((run): run is RoutineRun => run !== null)
      : (await this.list({ limit: 100 })).runs;
    return { runs, readiness: this.state };
  }

  private async reconcileOne(run: RoutineRun): Promise<void> {
    if (!run.agentId || !this.host.paseo) return;
    const agentId = run.agentId;
    try {
      const handle = this.host.paseo.agents.ref(run.agentId);
      const snapshot = await this.calls.run(() => handle.refresh(), "Host agent reconciliation");
      if (!snapshot) {
        if (run.executionStatus !== "reserved")
          await this.unknown(run, "No matching host agent evidence; external effects remain unknown.");
        return;
      }
      if (
        !run.managed ||
        snapshot.agent.id !== run.agentId ||
        snapshot.agent.labels[RUN_LABEL] !== run.id ||
        snapshot.agent.labels[EXECUTION_LABEL] !== run.executionId
      ) {
        await this.unknown(run, "Host agent identity did not match the admitted execution.");
        return;
      }
      await this.serial(() =>
        this.store.updateState((state) => {
          const saved = lookup(state, run.id);
          if (!saved?.managed || saved.executionId !== run.executionId) return;
          saved.agentCreationStatus = "created";
          saved.managed.hostCreatedAt ??= this.now();
        }),
      );
      const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
      await this.calls.run(
        () => (this.options.refresh ?? refreshPreparedChat)(this.relay, artifact.prepared),
        "Frozen relay restoration",
      );
      const timeline = await this.calls.run(
        () =>
          handle.timeline.refetch({
            direction: "tail",
            limit: 100,
            projection: "canonical",
          }),
        "Host timeline reconciliation",
      );
      const evidence = this.currentSessionEvidence(run, hostRunEvidence(run, snapshot.agent, timeline));
      await this.applyHostEvidence(run, evidence, timeline);
      if (evidence.status !== "unknown")
        await this.serial(() => this.sessions.active(agentId, run.sessionEpoch));
    } catch (error) {
      await this.unknown(run, `Host reconciliation unavailable: ${errorText(error)}`);
    }
  }

  private currentSessionEvidence(run: RoutineRun, evidence: HostRunEvidence): HostRunEvidence {
    if (run.sessionEpoch <= 1 || !["completed", "failed"].includes(evidence.status)) return evidence;
    return {
      ...evidence,
      status: "unknown",
      output: null,
      error: "Host turn evidence does not identify the reopened provider-session generation.",
    };
  }

  private applyHostEvidence(
    run: RoutineRun,
    evidence: HostRunEvidence,
    timeline: HostTimelineEvidence,
  ): Promise<void> {
    return this.serial(() =>
      this.store.updateState(async (state) => {
        const saved = lookup(state, run.id);
        if (!saved?.managed || !holds(saved) || saved.executionId !== run.executionId) return;
        if (saved.sessionEpoch !== run.sessionEpoch) return;
        await this.retainTimeline(saved, evidence, timeline);
        this.applyObserved(state, saved, evidence);
      }),
    );
  }

  private async retainTimeline(
    run: RoutineRun,
    evidence: HostRunEvidence,
    timeline: HostTimelineEvidence,
  ): Promise<void> {
    if (!run.managed) throw new Error("Missing managed timeline evidence.");
    const observedAt = this.now();
    const artifact = await this.artifacts.put({
      version: 1,
      runId: run.id,
      executionId: run.executionId,
      observedForSessionEpoch: run.sessionEpoch,
      source: "timeline",
      timeline,
      observedAt,
    });
    const complete = this.timelineComplete(timeline);
    const terminal = evidence.status === "completed" || evidence.status === "failed";
    run.managed.evidence = {
      artifact,
      source: "timeline",
      replyComplete: complete && evidence.output !== null && terminal,
      timelineComplete: complete,
      observedAt,
    };
    run.managed.hostCreatedAt ??= observedAt;
    run.agentCreationStatus = "created";
    if (terminal) run.managed.result = artifact;
  }

  private timelineComplete(timeline: HostTimelineEvidence): boolean {
    return (
      !timeline.error &&
      !timeline.gap &&
      !timeline.staleCursor &&
      !timeline.hasNewer &&
      timeline.hasOlder === false
    );
  }

  private applyObserved(state: RunSnapshot, run: RoutineRun, evidence: HostRunEvidence): void {
    if (!run.managed) throw new Error("Missing managed execution evidence.");
    run.managed.timeline = evidence.cursor;
    run.executionStatus = evidence.status;
    run.providerTurnId = providerTurnId(evidence.providerTurnId);
    run.output = evidence.output;
    run.error = evidence.error;
    if (evidence.status === "completed" || evidence.status === "failed") {
      run.managed.reservation = false;
      run.endedAt = new Date(this.now()).toISOString();
      this.setAttempt(run, evidence.status);
      state.coordinator.circuits[run.managed.provider] = providerCircuitSuccess();
    }
  }

  private unknown(observed: RoutineRun, error: string): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, observed.id);
        if (
          !run ||
          !holds(run) ||
          run.executionId !== observed.executionId ||
          run.sessionEpoch !== observed.sessionEpoch
        )
          return;
        run.executionStatus = "unknown";
        run.error = error;
        this.setAttempt(run, "unknown");
      }),
    );
  }
}
