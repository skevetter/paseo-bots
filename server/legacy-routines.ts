import type { Bot, BotState, Routine } from "../shared/bot";
import { ROUTINE_LABEL } from "../shared/chat";
import type { RoutineRecord, RoutineRun } from "../shared/rpc";
import { isTerminal, type Trigger } from "../shared/runs";
import { newUuid } from "../shared/uuid";
import { launchPreparedChat, prepareChat } from "./chats";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import type { CoordinatorOptions, RunCoordinator } from "./run-coordinator";

export interface LegacyRoutineInput {
  state: BotState;
  bot: Bot;
  routine: Routine;
  trigger: Trigger;
  due: Date;
  requestId: string;
  requestHash: string;
  prompt: string;
}

const unfinished = (run: RoutineRun) =>
  run.managed
    ? run.managed.reservation || !isTerminal(run.executionStatus)
    : !isTerminal(run.executionStatus);

/** Legacy runs share the authoritative writer, but never claim managed snapshots or reservations. */
export class LegacyRoutineRunner {
  private readonly pending = new Set<Promise<RoutineRun>>();
  private stopping = false;
  private readonly stoppingSignal = Promise.withResolvers<void>();
  private readonly stoppingController = new AbortController();

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
    private readonly coordinator: RunCoordinator,
    private readonly options: CoordinatorOptions,
  ) {}

  run(input: LegacyRoutineInput): Promise<RoutineRun> {
    if (this.stopping) return Promise.reject(new Error("Routine scheduler is stopping."));
    const pending = this.runOne(input).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return pending;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.stoppingController.abort();
    this.stoppingSignal.resolve();
    await Promise.allSettled(this.pending);
  }

  async finished(routineId: string, agentId: string, patch: Partial<RoutineRun>): Promise<RoutineRun | null> {
    if (this.stopping) return null;
    const { routines } = await this.coordinator.store.read();
    if (this.stopping) return null;
    const run = routines[routineId]?.runs.find(
      (entry) => !entry.managed && entry.agentId === agentId && !isTerminal(entry.executionStatus),
    );
    return run ? this.coordinator.finishLegacy(run.id, patch) : null;
  }

  private async runOne(input: LegacyRoutineInput): Promise<RoutineRun> {
    this.host.requirePaseo();
    if (this.stopping) throw new Error("Routine scheduler is stopping.");
    const { routines } = await this.coordinator.store.read();
    const evidence = await this.overlapEvidence(routines[input.routine.id]);
    if (this.stopping) throw new Error("Routine scheduler is stopping.");
    const { run, created } = await this.coordinator.recordLegacy(
      {
        botId: input.bot.id,
        routineId: input.routine.id,
        trigger: input.trigger,
        due: input.due,
        requestId: input.requestId,
        requestHash: input.requestHash,
      },
      (record, admitted) => this.initialize(input, record, admitted, evidence),
    );
    if (!created || isTerminal(run.executionStatus)) return run;
    if (this.stopping) return this.cancelBeforeLaunch(run);
    const agentId = newUuid();
    await this.coordinator.finishLegacy(run.id, { agentId });
    if (this.stopping) return this.cancelBeforeLaunch(run);
    return this.launch(input, run, agentId);
  }

  private initialize(
    input: LegacyRoutineInput,
    record: RoutineRecord,
    run: RoutineRun,
    evidence: ReadonlyMap<string, boolean>,
  ): void {
    if (input.bot.hostId) {
      Object.assign(run, {
        executionStatus: "failed",
        taskOutcome: "no_change",
        agentId: null,
        endedAt: this.timestamp(),
        error: `${input.bot.name} runs on another host, so its chats can't be started from here.`,
      });
      return;
    }
    const busy = record.runs.filter((entry) => unfinished(entry) && (evidence.get(entry.id) ?? true));
    const managed = record.runs.some((entry) => entry.managed && unfinished(entry));
    if (!managed && busy.length < (input.trigger === "webhook" ? 3 : 1)) return;
    Object.assign(run, {
      executionStatus: "canceled",
      taskOutcome: "no_change",
      skipped: "busy",
      agentId: null,
      endedAt: this.timestamp(),
    });
  }

  private async overlapEvidence(record: RoutineRecord | undefined): Promise<Map<string, boolean>> {
    const evidence = new Map<string, boolean>();
    await Promise.all(
      (record?.runs ?? []).filter(unfinished).map(async (run) => {
        if (run.managed || run.executionStatus === "starting" || !run.agentId) {
          evidence.set(run.id, true);
          return;
        }
        try {
          const observed = await this.beforeStop(
            Promise.resolve(this.host.paseo?.agents.ref(run.agentId).refresh()),
          );
          evidence.set(
            run.id,
            observed === null ||
              observed.value?.agent.status === "running" ||
              observed.value?.agent.status === "initializing",
          );
        } catch {
          evidence.set(run.id, false);
        }
      }),
    );
    return evidence;
  }

  private async launch(input: LegacyRoutineInput, run: RoutineRun, agentId: string): Promise<RoutineRun> {
    let creating = false;
    try {
      if (this.stopping) return this.cancelBeforeLaunch(run);
      const prepared = await this.beforeStop(
        (this.options.prepare ?? prepareChat)(this.host, this.relay, input.bot, {
          state: input.state,
          routineId: input.routine.id,
          agentId,
          idempotencyKey: run.executionId,
          prompt: input.prompt,
          title: input.routine.name,
          labels: { [ROUTINE_LABEL]: input.routine.id },
          purpose: "task",
        }),
      );
      if (!prepared || this.stopping) return this.cancelBeforeLaunch(run);
      creating = true;
      const actual = await this.beforeStop(
        (this.options.launch ?? launchPreparedChat)(this.host, this.relay, prepared.value, {
          signal: this.stoppingController.signal,
        }),
      );
      if (!actual) return { ...run, agentId };
      if (actual.value !== agentId)
        throw new Error("Host did not preserve the selected legacy agent identity.");
      return await this.coordinator.finishLegacy(run.id, { executionStatus: "running", agentId });
    } catch (error) {
      return this.failLaunch(run, agentId, creating, error);
    }
  }

  private failLaunch(
    run: RoutineRun,
    agentId: string,
    creating: boolean,
    error: unknown,
  ): Promise<RoutineRun> | RoutineRun {
    if (this.stopping) return creating ? { ...run, agentId } : this.cancelBeforeLaunch(run);
    return this.coordinator.finishLegacy(run.id, {
      executionStatus: "failed",
      taskOutcome: "unknown",
      endedAt: this.timestamp(),
      agentId: null,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private async beforeStop<T>(operation: Promise<T>): Promise<{ value: T } | null> {
    return Promise.race([
      operation.then((value) => ({ value })),
      this.stoppingSignal.promise.then(() => null),
    ]);
  }

  private cancelBeforeLaunch(run: RoutineRun): Promise<RoutineRun> {
    return this.coordinator.finishLegacy(run.id, {
      executionStatus: "canceled",
      taskOutcome: "no_change",
      endedAt: this.timestamp(),
      agentId: null,
    });
  }

  private timestamp(): string {
    return new Date((this.options.now ?? Date.now)()).toISOString();
  }
}
