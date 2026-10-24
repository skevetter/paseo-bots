import type { PluginServerContext } from "@getpaseo/plugin/server";
import { BOT_LABEL, type Bot, type BotState } from "../shared/bot";
import {
  type CreationEvidence,
  PreparedLaunchAbortedError,
  PreparedLaunchNotCreatedError,
} from "../shared/chat";
import { HostCapabilityError } from "../shared/host-capability";
import {
  chatsStartRpc,
  ExecutionPlanIdSchema,
  type LocalChatInput,
  LocalChatInputSchema,
  type LocalChatStartResult,
  type LocalPreparedPlan,
  type LocalRunSummary,
  runsPrepareRpc,
  runsStartRpc,
} from "../shared/local-start";
import type { RoutineRun } from "../shared/rpc";
import { isTerminal } from "../shared/runs";
import { newUuid } from "../shared/uuid";
import { launchPreparedChat, prepareChat } from "./chats";
import type { BotsHost } from "./host";
import type { Relay } from "./relay";
import type { RunCoordinator } from "./run-coordinator";
import { BoundedHostCalls, HostCallNotDispatchedError } from "./run-deadlines";
import { type ReplayRequest, requestHashOf, requestKey } from "./run-requests";

export interface LocalChatStartsOptions {
  creationWaitMs?: number;
  legacyTimeoutMs?: number;
  now?: () => number;
}

function summary(run: RoutineRun): LocalRunSummary {
  return {
    id: run.id,
    executionStatus: run.executionStatus,
    agentCreationStatus: run.agentCreationStatus ?? "unknown",
    taskOutcome: run.taskOutcome,
    purpose: run.purpose,
  };
}

function plan(run: RoutineRun): LocalPreparedPlan {
  if (!run.managed || !run.agentId)
    throw new Error(
      "This retained request is legacy and cannot become a managed plan. Inspect it with chats.start using the same request.",
    );
  return { planId: ExecutionPlanIdSchema.parse(run.id), plannedAgentId: run.agentId, run: summary(run) };
}

export class LocalChatStarts {
  private readonly preparations = new Map<string, Promise<unknown>>();
  private readonly calls: BoundedHostCalls;
  private readonly now: () => number;
  private stopped = false;

  constructor(
    private readonly host: BotsHost,
    private readonly relay: Relay,
    private readonly coordinator: RunCoordinator,
    private readonly options: LocalChatStartsOptions = {},
  ) {
    for (const value of [options.creationWaitMs, options.legacyTimeoutMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new Error("Local creation waits must be nonnegative safe integers.");
    }
    this.calls = new BoundedHostCalls(options.legacyTimeoutMs ?? 30_000);
    this.now = options.now ?? Date.now;
  }

  prepare(rawInput: unknown): Promise<LocalPreparedPlan> {
    const input = LocalChatInputSchema.parse(rawInput);
    return this.serialize(input, async (request) => {
      const prior = await this.coordinator.findRequest(request);
      if (prior) return plan(prior);
      const { state, bot } = await this.target(input);
      return this.admit(input, request, state, bot);
    });
  }

  async start(planId: string): Promise<LocalChatStartResult> {
    this.active();
    const id = ExecutionPlanIdSchema.parse(planId);
    await this.coordinator.startPrepared(id);
    this.active();
    const receipt = await this.coordinator.waitForCreation(id, {
      timeoutMs: this.options.creationWaitMs ?? 1_000,
    });
    const prepared = plan(receipt.run);
    return {
      status: receipt.status,
      mode: "managed",
      agentId: receipt.status === "created" ? receipt.agentId : null,
      plannedAgentId: prepared.plannedAgentId,
      planId: prepared.planId,
      run: prepared.run,
      message:
        receipt.status === "created"
          ? null
          : receipt.status === "pending"
            ? "Creation is not confirmed. Inspect this managed plan; do not start another request to retry."
            : "The managed plan ended before agent creation.",
    };
  }

  async create(rawInput: unknown): Promise<LocalChatStartResult> {
    const input = LocalChatInputSchema.parse(rawInput);
    const admission = await this.serialize<LocalPreparedPlan | LocalChatStartResult>(
      input,
      async (request) => {
        const prior = await this.coordinator.findRequest(request);
        if (prior) return prior.managed ? plan(prior) : this.replayLegacy(prior, input.botId);
        const { state, bot } = await this.target(input);
        if (bot.executionMode === "managed") return this.admit(input, request, state, bot);
        return this.legacy(input, request, state, bot);
      },
    );
    return "status" in admission ? admission : this.start(admission.planId);
  }

  stop(): void {
    this.stopped = true;
    this.calls.close();
  }

  private active(): void {
    if (this.stopped) throw new Error("Local chat starts are stopped.");
  }

  private async target(input: LocalChatInput): Promise<{ state: BotState; bot: Bot }> {
    const state = structuredClone(await this.host.values());
    this.active();
    const bot = state.bots.find((entry) => entry.id === input.botId);
    if (!bot || bot.archived) throw new Error("The target bot is unavailable.");
    if (bot.hostId) throw new Error("Local chat starts cannot launch a bot on another host.");
    if (input.routineId && !bot.routines.some((routine) => routine.id === input.routineId))
      throw new Error("The target routine is unavailable.");
    return { state, bot };
  }

  private serialize<T>(input: LocalChatInput, work: (request: ReplayRequest) => Promise<T>): Promise<T> {
    this.active();
    const request: ReplayRequest = {
      botId: input.botId,
      routineId: input.routineId,
      trigger: "manual",
      requestId: input.requestId,
      requestHash: requestHashOf(input),
    };
    const key = requestKey(request);
    const previous = this.preparations.get(key) ?? Promise.resolve();
    const pending = previous
      .catch(() => {})
      .then(() => {
        this.active();
        return work(request);
      });
    this.preparations.set(key, pending);
    void pending
      .finally(() => {
        if (this.preparations.get(key) === pending) this.preparations.delete(key);
      })
      .catch(() => {});
    return pending;
  }

  private async admit(
    input: LocalChatInput,
    request: ReplayRequest,
    state: BotState,
    bot: Bot,
  ): Promise<LocalPreparedPlan> {
    if (bot.executionMode !== "managed")
      throw new Error("runs.prepare requires explicit managed execution mode.");
    const agentId = input.agentId ?? newUuid();
    if (input.agentId) await this.inspectIdentity(agentId);
    const due = new Date(this.now());
    const prepared = await prepareChat(this.host, this.relay, bot, {
      ...input,
      agentId,
      idempotencyKey: input.idempotencyKey ?? `paseo-bots:${agentId}`,
      state,
    });
    this.active();
    const runtime = bot.routines.find((routine) => routine.id === input.routineId)?.runtime;
    const routineDeadline =
      runtime?.deadlineSeconds === undefined ? Infinity : due.getTime() + runtime.deadlineSeconds * 1000;
    const deadline = Math.min(input.deadlineAt ?? Infinity, routineDeadline);
    const run = await this.coordinator.admitPrepared(prepared, {
      ...request,
      due,
      state,
      deferLaunch: true,
      deadlineAt: deadline === Infinity ? undefined : deadline,
      resourceIds: runtime?.resourceIds,
      capacity: runtime?.capacity,
      overlap: runtime?.overlap ?? "queue",
    });
    return plan(run);
  }

  private async legacy(
    input: LocalChatInput,
    request: ReplayRequest,
    state: BotState,
    bot: Bot,
  ): Promise<LocalChatStartResult> {
    this.host.requirePaseo();
    const agentId = input.agentId ?? newUuid();
    if (input.agentId) await this.inspectIdentity(agentId);
    const { run, created: admitted } = await this.coordinator.recordLegacy(
      {
        ...request,
        botId: bot.id,
        routineId: input.routineId ?? `chat:${bot.id}`,
        due: new Date(this.now()),
      },
      (_record, run) => {
        run.agentId = agentId;
        run.purpose = input.purpose;
      },
    );
    if (!admitted) return run.managed ? this.start(run.id) : this.replayLegacy(run, bot.id);
    return this.launchLegacy(input, state, bot, run);
  }

  private async inspectIdentity(agentId: string): Promise<void> {
    const paseo = this.host.requirePaseo();
    const existing = await this.calls.run(
      () => paseo.agents.ref(agentId).refresh(),
      "Caller-selected identity inspection",
    );
    this.active();
    if (existing)
      throw new Error("The chosen agent ID already exists. Use a fresh identity for a new request.");
  }

  private async launchLegacy(
    input: LocalChatInput,
    state: BotState,
    bot: Bot,
    run: RoutineRun,
  ): Promise<LocalChatStartResult> {
    const agentId = run.agentId;
    if (!agentId) throw new Error("The legacy request has no retained agent identity.");
    let evidence: CreationEvidence | null = null;
    const observed: { acknowledgement?: Promise<RoutineRun> } = {};
    let creationProven = false;
    try {
      const created = await this.calls.run(async (signal) => {
        const prepared = await prepareChat(this.host, this.relay, bot, {
          ...input,
          executionMode: "legacy",
          agentId,
          idempotencyKey: input.idempotencyKey ?? `paseo-bots:${agentId}`,
          state,
        }).catch((error: unknown) => {
          throw new PreparedLaunchNotCreatedError(
            "Chat preparation failed before requesting agent creation.",
            error,
          );
        });
        if (this.stopped || signal.aborted) throw new PreparedLaunchAbortedError();
        await this.coordinator
          .finishLegacy(run.id, { agentCreationStatus: "unknown" })
          .catch((error: unknown) => {
            throw new PreparedLaunchNotCreatedError(
              "Creation intent could not be persisted before requesting agent creation.",
              error,
            );
          });
        if (this.stopped || signal.aborted) throw new PreparedLaunchAbortedError();
        return launchPreparedChat(this.host, this.relay, prepared, {
          signal,
          onEvent: (event) => {
            if (this.stopped || signal.aborted) return;
            evidence = event;
            if (
              !creationProven &&
              event.kind === "agent" &&
              event.agentId === agentId &&
              ["agent_ready", "prompt_started", "completed"].includes(event.phase)
            ) {
              creationProven = true;
              observed.acknowledgement = this.coordinator.finishLegacy(run.id, {
                agentCreationStatus: "created",
              });
              // SDK observers are synchronous; observe rejection now and join the write before replying.
              void observed.acknowledgement.catch(() => {});
            }
          },
        });
      }, "Legacy chat creation");
      if (created !== agentId) throw new Error("The host did not preserve the planned legacy identity.");
      if (observed.acknowledgement) run = await observed.acknowledgement;
      if (!this.stopped)
        run = await this.coordinator.finishLegacy(run.id, {
          executionStatus: "running",
          agentCreationStatus: "created",
        });
      return this.legacyResult(run);
    } catch (error) {
      const retained = await observed.acknowledgement?.catch(() => null);
      return this.failLegacy(retained ?? run, error, evidence, creationProven);
    }
  }

  private async failLegacy(
    run: RoutineRun,
    error: unknown,
    evidence: CreationEvidence | null,
    creationProven: boolean,
  ): Promise<LocalChatStartResult> {
    if (!this.stopped) run = (await this.coordinator.get(run.id)) ?? run;
    const creation = this.legacyFailureCreation(run, error, evidence, creationProven);
    const noCreate = creation === "not_created";
    if (!this.stopped)
      run = await this.coordinator.finishLegacy(run.id, {
        executionStatus: noCreate ? "failed" : "unknown",
        taskOutcome: "unknown",
        agentCreationStatus: creation,
        endedAt: new Date(this.now()).toISOString(),
        error: `${noCreate ? "Creation was refused before agent creation." : "Legacy launch did not complete; inspect this host before retrying."} ${error instanceof Error ? error.message : String(error)}`,
      });
    return this.legacyResult(run);
  }

  private legacyFailureCreation(
    run: RoutineRun,
    error: unknown,
    evidence: CreationEvidence | null,
    creationProven: boolean,
  ): "created" | "not_created" | "unknown" {
    if (creationProven || run.agentCreationStatus === "created") return "created";
    if (evidence?.outcomeUnknown) return "unknown";
    if (
      error instanceof HostCapabilityError ||
      error instanceof PreparedLaunchNotCreatedError ||
      error instanceof HostCallNotDispatchedError
    )
      return "not_created";
    return "unknown";
  }

  private async replayLegacy(run: RoutineRun, botId: string): Promise<LocalChatStartResult> {
    this.active();
    if (
      (run.agentCreationStatus === "created" && run.agentId) ||
      (isTerminal(run.executionStatus) && run.agentCreationStatus === "not_created")
    )
      return this.legacyResult(run);
    const paseo = this.host.paseo;
    const agentId = run.agentId;
    if (!paseo || !agentId) return this.legacyResult(run);
    try {
      const snapshot = await this.calls.run(
        () => paseo.agents.ref(agentId).refresh(),
        "Legacy creation observation",
      );
      this.active();
      if (snapshot?.agent.id === run.agentId && snapshot.agent.labels?.[BOT_LABEL] === botId) {
        run = await this.coordinator.finishLegacy(run.id, { agentCreationStatus: "created" });
        return this.legacyResult(run);
      }
    } catch {
      // Missing or unavailable host evidence never authorizes another launch.
    }
    return this.legacyResult(run);
  }

  private legacyResult(run: RoutineRun): LocalChatStartResult {
    const status =
      run.agentCreationStatus === "created" && run.agentId
        ? "created"
        : isTerminal(run.executionStatus) && run.agentCreationStatus === "not_created"
          ? "not_created"
          : "pending";
    return {
      status,
      mode: "legacy",
      agentId: status === "created" ? run.agentId : null,
      plannedAgentId: run.agentId,
      planId: null,
      run: null,
      message: this.legacyMessage(status, run.error),
    };
  }

  private legacyMessage(status: LocalChatStartResult["status"], error: string | null): string | null {
    if (status === "created") return null;
    const message =
      status === "not_created"
        ? "The retained legacy request ended without agent creation."
        : "Legacy creation is unconfirmed. Its retained request identity prevents relaunch, but it has no frozen recovery plan or managed accounting. Inspect the planned agent ID on this host; do not retry with a new request ID.";
    return error ? `${message} ${error}` : message;
  }
}

export function registerLocalStarts(
  server: PluginServerContext,
  host: BotsHost,
  starts: LocalChatStarts,
): void {
  server.handle(runsPrepareRpc, (input, context) => {
    host.attach(context.paseo);
    return starts.prepare(input);
  });
  server.handle(runsStartRpc, (input, context) => {
    host.attach(context.paseo);
    return starts.start(input.planId);
  });
  server.handle(chatsStartRpc, (input, context) => {
    host.attach(context.paseo);
    return starts.create(input);
  });
}
