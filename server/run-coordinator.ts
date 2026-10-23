import { createHash } from "node:crypto";
import { dirname } from "node:path";
import type { Bot, Routine } from "../shared/bot";
import type { CreationEvidence, PreparedBotChat } from "../shared/chat";
import { EXECUTION_LABEL, type HostReadiness, OCCURRENCE_LABEL, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";
import {
  isTerminal,
  newAttemptId,
  newExecutionId,
  newSessionEpoch,
  OccurrenceKeySchema,
  occurrenceKeyOf,
  type Purpose,
  providerTurnId,
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
import { type HostRunEvidence, hostRunEvidence } from "./run-host-evidence";
import { admitRun, appendRun, emptyRecord, type RunSnapshot, RunStore } from "./run-store";

export interface Admission {
  bot: Bot;
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
}
export interface PreparedAdmission {
  routineId?: string;
  trigger: Trigger;
  due: Date;
  requestId: string;
  resourceIds?: string[];
  overlap?: "skip" | "queue" | "coalesce";
  capacity?: Partial<CapacityLimits>;
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
  routineId?: string;
}
const allRuns = (state: RunSnapshot) => Object.values(state.routines).flatMap((record) => record.runs);
const lookup = (state: RunSnapshot, id: string) => allRuns(state).find((run) => run.id === id);
const copy = <T>(value: T): T => structuredClone(value);
const holds = (run: RoutineRun) =>
  run.managed?.reservation ?? (!isTerminal(run.executionStatus) || run.executionStatus === "unknown");
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function admissionOccurrence(recordId: string, input: PreparedAdmission) {
  if (input.trigger === "schedule")
    return occurrenceKeyOf(recordId, input.trigger, input.due.toISOString(), input.requestId);
  const digest = createHash("sha256")
    .update(JSON.stringify([recordId, input.trigger, input.requestId]))
    .digest("hex");
  return OccurrenceKeySchema.parse(`request:${digest}`);
}

function existingOccurrence(state: RunSnapshot, key: string): RoutineRun | null {
  const id = state.coordinator.occurrences[key];
  if (!id) return null;
  const run = lookup(state, id);
  if (!run) throw new Error(`Occurrence ${key} already exists as ${id}; replay refused.`);
  return run;
}

/** The sole admission boundary. An uncertain host call is reconciled, never replayed. */
export class RunCoordinator {
  readonly store: RunStore;
  private readonly artifacts: RunArtifacts;
  private readonly lock: CoordinatorLock;
  private readonly epoch = newSessionEpoch();
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
    this.opened = this.lock.acquire();
    void this.opened.catch(() => {});
    this.detach = host.onAttach(() => {
      void this.recover().catch((error: unknown) =>
        console.error("paseo-bots: coordinator recovery failed", error),
      );
    });
  }

  get readiness(): HostReadiness {
    return this.state;
  }

  private async serial<T>(work: () => Promise<T>): Promise<T> {
    await this.opened;
    if (this.stopped) throw new Error("Run coordinator is stopped.");
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }

  async stop(): Promise<void> {
    this.closing = true;
    clearTimeout(this.wake);
    this.detach();
    await Promise.allSettled([this.recovery]);
    await this.queue;
    await Promise.allSettled(this.launches.values());
    await this.queue;
    this.stopped = true;
    this.state = "stopped";
    await this.opened.then(() => this.lock.release());
  }

  async admit(input: Admission): Promise<RoutineRun> {
    const key = admissionOccurrence(input.routine?.id ?? `chat:${input.bot.id}`, input);
    const prior = await this.serial(async () => copy(existingOccurrence(await this.store.read(), key)));
    if (prior) {
      await this.recovery;
      await this.pump();
      return (await this.get(prior.id)) ?? prior;
    }
    const identity = admitRun({
      routineId: input.routine?.id ?? `chat:${input.bot.id}`,
      trigger: input.trigger,
      due: input.due,
      now: new Date(this.now()),
      epoch: this.epoch,
    });
    identity.occurrenceKey = key;
    if (input.bot.hostId)
      return this.rejectAdmission(
        input,
        identity,
        "Routines run on the host that stores the bot; this bot runs on another host.",
      );
    this.host.requirePaseo();
    const agentId = newUuid();
    let prepared: PreparedBotChat;
    try {
      prepared = await (this.options.prepare ?? prepareChat)(this.host, this.relay, input.bot, {
        agentId,
        idempotencyKey: identity.executionId,
        prompt: input.prompt,
        title: input.title,
        routineId: input.routine?.id,
        purpose: input.purpose,
        labels: {
          ...input.labels,
          [RUN_LABEL]: identity.id,
          [EXECUTION_LABEL]: identity.executionId,
          [OCCURRENCE_LABEL]: key,
        },
      });
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
    const existing = existingOccurrence(state, run.occurrenceKey);
    if (existing) return copy(existing);
    run.executionStatus = "failed";
    run.taskOutcome = "no_change";
    run.error = error;
    run.endedAt = new Date(this.now()).toISOString();
    const id = input.routine?.id ?? `chat:${input.bot.id}`;
    const record = state.routines[id] ?? emptyRecord();
    if (run.trigger === "schedule") record.lastRunAt = run.scheduledFor;
    appendRun(record, run);
    state.routines[id] = record;
    state.coordinator.occurrences[run.occurrenceKey] = run.id;
    return copy(run);
  }

  async admitPrepared(
    prepared: PreparedBotChat,
    input: PreparedAdmission,
    identity?: RoutineRun,
  ): Promise<RoutineRun> {
    if (this.closing) throw new Error("Run coordinator is stopping.");
    const admitted = await this.serial(async () => {
      const run =
        identity ??
        admitRun({
          routineId: input.routineId ?? `chat:${prepared.botId}`,
          trigger: input.trigger,
          due: input.due,
          now: new Date(this.now()),
          epoch: this.epoch,
        });
      const recordId = input.routineId ?? `chat:${prepared.botId}`;
      run.occurrenceKey = admissionOccurrence(recordId, input);
      const saved = await this.store.read();
      const existing = existingOccurrence(saved, run.occurrenceKey);
      if (existing) return copy(existing);
      this.validateAgentIdentity(saved, prepared.agentId);
      const frozen = copy(prepared);
      frozen.labels = {
        ...frozen.labels,
        [RUN_LABEL]: run.id,
        [EXECUTION_LABEL]: run.executionId,
        [OCCURRENCE_LABEL]: run.occurrenceKey,
      };
      frozen.clientMessageId ??= run.executionId;
      frozen.metadata.systemPromptHash = createHash("sha256")
        .update(frozen.config.systemPrompt)
        .digest("hex");
      frozen.metadata.userPromptHash = createHash("sha256").update(frozen.prompt).digest("hex");
      if (!frozen.hostId)
        frozen.metadata.environmentVersion ??= `paseo-bots/${PLUGIN_VERSION};node/${process.version};${process.platform}/${process.arch}`;
      const artifact = await this.artifacts.put({ prepared: frozen, capacity: input.capacity ?? {} });
      this.initialize(run, frozen, input, artifact);
      await this.store.updateState((state) => this.recordAdmission(state, recordId, run));
      return copy(run);
    });
    await this.recovery;
    await this.pump();
    return (await this.get(admitted.id)) ?? admitted;
  }

  private validateAgentIdentity(state: RunSnapshot, agentId: string): void {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentId))
      throw new Error("Managed agent identity must be an RFC 4122 v4 UUID.");
    if (allRuns(state).some((entry) => entry.agentId === agentId))
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
    const active = record.runs.some(holds);
    const queued = record.runs.find((entry) => entry.executionStatus === "queued");
    const webhookRoom =
      managed.overlapLimit > 1 &&
      record.runs.filter((entry) => holds(entry) || entry.executionStatus === "queued").length <
        managed.overlapLimit;
    const decision = webhookRoom ? "admit" : overlapDecision(managed.overlap, active, !!queued);
    if (decision === "skip" || decision === "coalesce") {
      run.executionStatus = "canceled";
      run.taskOutcome = "no_change";
      run.skipped = "busy";
      run.endedAt = new Date(this.now()).toISOString();
      managed.coalescedInto = decision === "coalesce" ? (queued?.id ?? null) : null;
    }
    if (run.trigger === "schedule") record.lastRunAt = run.scheduledFor;
    state.coordinator.occurrences[run.occurrenceKey] = run.id;
    appendRun(record, run);
  }

  async recordMissed(routineId: string, due: Date, now: Date): Promise<RoutineRun> {
    return this.serial(() =>
      this.store.updateState((state) => {
        const run = admitRun({ routineId, trigger: "schedule", due, now, epoch: this.epoch });
        const prior = state.coordinator.occurrences[run.occurrenceKey];
        const existing = prior ? lookup(state, prior) : null;
        if (existing) return copy(existing);
        if (prior) throw new Error("Missed occurrence already recorded; replay refused.");
        run.executionStatus = "canceled";
        run.taskOutcome = "no_change";
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

  async get(id: string): Promise<RoutineRun | null> {
    await this.opened;
    return copy(lookup(await this.store.read(), id) ?? null);
  }

  async list(
    filter: RunFilter = {},
  ): Promise<{ runs: RoutineRun[]; cursor: string | null; readiness: HostReadiness }> {
    await this.opened;
    const runs = allRuns(await this.store.read())
      .filter(
        (run) =>
          (!filter.botId || run.managed?.botId === filter.botId) &&
          (!filter.routineId || run.managed?.routineId === filter.routineId) &&
          (!filter.executionStatus || run.executionStatus === filter.executionStatus),
      )
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
    const offset = filter.cursor ? runs.findIndex((run) => run.id === filter.cursor) + 1 : 0;
    if (filter.cursor && offset === 0) throw new Error("Run cursor no longer exists. Reload the first page.");
    const page = runs.slice(offset, offset + Math.min(100, Math.max(1, filter.limit ?? 30)));
    return {
      runs: copy(page),
      cursor: offset + page.length < runs.length ? (page.at(-1)?.id ?? null) : null,
      readiness: this.state,
    };
  }

  async pump(): Promise<void> {
    if (!this.host.paseo || this.stopped || this.closing || this.state === "reconciling") return;
    const admitted = await this.serial(async () => {
      const selected: string[] = [];
      await this.store.updateState(async (state) => {
        for (const run of allRuns(state)) {
          if (run.executionStatus === "reserved" || (await this.reserve(state, run))) selected.push(run.id);
        }
      });
      return selected;
    });
    await Promise.all(admitted.map((id) => this.launch(id)));
    await this.armWake();
  }

  private async armWake(): Promise<void> {
    clearTimeout(this.wake);
    if (this.closing) return;
    const state = await this.store.read();
    const times = allRuns(state)
      .filter((run) => run.executionStatus === "queued" && run.managed)
      .map((run) => {
        const circuit = state.coordinator.circuits[run.managed?.provider ?? ""];
        return Math.max(run.managed?.notBefore ?? 0, circuit?.openUntil ?? 0);
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

  private async reserve(state: RunSnapshot, run: RoutineRun): Promise<boolean> {
    const managed = run.managed;
    if (!managed || run.executionStatus !== "queued" || managed.notBefore > this.now()) return false;
    const active = allRuns(state).filter((entry) => entry.id !== run.id && holds(entry));
    const sameRoutine = active.filter(
      (entry) => entry.managed?.routineId === managed.routineId && managed.routineId !== null,
    );
    if (sameRoutine.length >= managed.overlapLimit) return false;
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
    run.sessionEpoch = this.epoch;
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
    const prepared = await this.serial(async () => {
      let result: PreparedBotChat | null = null;
      await this.store.updateState(async (state) => {
        const run = lookup(state, id);
        if (!run?.managed || run.executionStatus !== "reserved") return;
        const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
        result = artifact.prepared;
        run.executionStatus = "starting";
        this.setAttempt(run, "starting");
      });
      return result as PreparedBotChat | null;
    });
    if (!prepared) return;
    let evidence: CreationEvidence | null = null;
    try {
      const agentId = await (this.options.launch ?? launchPreparedChat)(
        this.host,
        this.relay,
        prepared,
        (value) => {
          evidence = value;
        },
      );
      if (agentId !== prepared.agentId)
        throw new Error("Host did not preserve the admitted agent identity; reconcile required.");
      await this.launched(id, evidence);
    } catch (error) {
      await this.launchFailed(id, error, evidence);
    }
  }

  private async launched(id: string, evidence: CreationEvidence | null): Promise<void> {
    await this.serial(() => this.store.updateState((state) => this.recordLaunched(state, id, evidence)));
  }

  private recordLaunched(state: RunSnapshot, id: string, evidence: CreationEvidence | null): void {
    const run = lookup(state, id);
    if (!run?.managed) return;
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
    run.managed.creation = {
      key: evidence.idempotencyKey,
      revision: evidence.revision,
      phase: evidence.phase,
      outcomeUnknown: evidence.outcomeUnknown ?? false,
    };
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

  private async launchFailed(id: string, error: unknown, evidence: CreationEvidence | null): Promise<void> {
    await this.serial(() =>
      this.store.updateState(async (state) => {
        const run = lookup(state, id);
        if (!run?.managed || run.executionStatus !== "starting") return;
        this.creation(run, evidence);
        run.error = errorText(error);
        if (
          !(error instanceof ProvenInfrastructureError) ||
          error.provider !== run.managed.provider ||
          evidence?.outcomeUnknown
        ) {
          run.executionStatus = "unknown";
          this.setAttempt(run, "unknown");
          return;
        }
        await this.safeFailure(state, run, error);
      }),
    );
  }

  private async safeFailure(
    state: RunSnapshot,
    run: RoutineRun,
    error: ProvenInfrastructureError,
  ): Promise<void> {
    const managed = run.managed;
    if (!managed) return;
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
    if (next === null) {
      run.executionStatus = "failed";
      run.taskOutcome = "no_change";
      run.endedAt = new Date(this.now()).toISOString();
      return;
    }
    const artifact = await this.artifacts.get<{
      prepared: PreparedBotChat;
      capacity: Partial<CapacityLimits>;
    }>(managed.artifact);
    run.attemptId = newAttemptId();
    run.executionId = newExecutionId();
    run.agentId = newUuid();
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

  async finished(agentId: string, input: ExecutionEnd): Promise<RoutineRun | null> {
    const run = await this.serial(() =>
      this.store.updateState((state) => this.settleExecution(state, agentId, input)),
    );
    await this.pump();
    return run;
  }

  private settleExecution(state: RunSnapshot, agentId: string, input: ExecutionEnd): RoutineRun | null {
    const found = allRuns(state).find((entry) => entry.agentId === agentId && holds(entry));
    if (!found?.managed || (input.executionId && found.executionId !== input.executionId)) return null;
    if (input.routineId && found.managed.routineId !== input.routineId) return null;
    found.executionStatus = input.kind;
    found.providerTurnId = providerTurnId(input.turnId);
    found.taskOutcome = "unknown";
    found.endedAt = new Date(this.now()).toISOString();
    found.output = input.reply?.trim().slice(0, 400) || null;
    found.error = input.error ?? null;
    found.managed.reservation = false;
    this.setAttempt(found, input.kind);
    return copy(found);
  }

  async cancel(id: string): Promise<{ run: RoutineRun; error: string | null }> {
    const result = await this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, id);
        if (!run) throw new Error("Run not found.");
        if (!run.managed) throw new Error("Legacy runs require manual host reconciliation.");
        run.managed.cancelRequested = true;
        const beforeLaunch = run.executionStatus === "queued" || run.executionStatus === "reserved";
        if (beforeLaunch) {
          run.executionStatus = "canceled";
          run.taskOutcome = "no_change";
          run.endedAt = new Date(this.now()).toISOString();
          run.managed.reservation = false;
          this.setAttempt(run, "canceled");
        }
        return { run: copy(run), beforeLaunch };
      }),
    );
    if (result.beforeLaunch || !holds(result.run)) return { run: result.run, error: null };
    if (!this.options.cancel)
      return {
        run: result.run,
        error:
          "The attached Paseo API does not expose active cancellation. Stop the agent in Paseo, then reconcile; capacity remains reserved.",
      };
    await this.options.cancel(result.run.agentId ?? "");
    return { run: result.run, error: null };
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
    return this.recovery.then(() => this.pump());
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
    for (const run of candidates) await this.reconcileOne(run);
    const runs = id
      ? [await this.get(id)].filter((run): run is RoutineRun => run !== null)
      : (await this.list({ limit: 100 })).runs;
    return { runs, readiness: this.state };
  }

  private async reconcileOne(run: RoutineRun): Promise<void> {
    if (!run.agentId || !this.host.paseo) return;
    try {
      const handle = this.host.paseo.agents.ref(run.agentId);
      const snapshot = await handle.refresh();
      if (!snapshot) {
        if (run.executionStatus !== "reserved")
          await this.unknown(run.id, "No matching host agent evidence; external effects remain unknown.");
        return;
      }
      if (!run.managed || snapshot.agent.labels[EXECUTION_LABEL] !== run.executionId) {
        await this.unknown(run.id, "Host agent identity did not match the admitted execution.");
        return;
      }
      const artifact = await this.artifacts.get<{ prepared: PreparedBotChat }>(run.managed.artifact);
      await (this.options.refresh ?? refreshPreparedChat)(this.relay, artifact.prepared);
      const timeline = await handle.timeline.refetch({
        direction: "tail",
        limit: 100,
        projection: "canonical",
      });
      await this.applyHostEvidence(run, hostRunEvidence(run, snapshot.agent, timeline));
    } catch (error) {
      await this.unknown(run.id, `Host reconciliation unavailable: ${errorText(error)}`);
    }
  }

  private applyHostEvidence(run: RoutineRun, evidence: HostRunEvidence): Promise<void> {
    return this.serial(() =>
      this.store.updateState((state) => {
        const saved = lookup(state, run.id);
        if (!saved?.managed || !holds(saved) || saved.executionId !== run.executionId) return;
        saved.managed.timeline = evidence.cursor;
        saved.executionStatus = evidence.status;
        saved.providerTurnId = providerTurnId(evidence.providerTurnId);
        saved.output = evidence.output;
        saved.error = evidence.error;
        if (evidence.status === "completed" || evidence.status === "failed") {
          saved.managed.reservation = false;
          saved.endedAt = new Date(this.now()).toISOString();
          this.setAttempt(saved, evidence.status);
          state.coordinator.circuits[saved.managed.provider] = providerCircuitSuccess();
        }
      }),
    );
  }

  private unknown(id: string, error: string): Promise<void> {
    return this.serial(() =>
      this.store.updateState((state) => {
        const run = lookup(state, id);
        if (!run || !holds(run)) return;
        run.executionStatus = "unknown";
        run.error = error;
        this.setAttempt(run, "unknown");
      }),
    );
  }
}
