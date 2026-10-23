import type { BotState } from "../bot";
import { OPERATION_ID } from "./ids";
import { type ApplicationReceipt, MAX_RECEIPT_CREATED, MAX_RECEIPTS, type SkillPublication } from "./receipt";

/** One request to change the setup. The caller makes the id and hashes the body; nothing here reads a clock. */
export interface Operation {
  id: string;
  kind: string;
  /** Of everything that decides what the operation does, so a reused id with other content is caught. */
  bodyHash: string;
  /** What the operation counts as the time it ran, which its changes stamp on what they make. */
  at: string;
  /** Pins the receipt until the caller durably records completion of its remaining work. */
  pending?: boolean;
}

export class OperationConflictError extends Error {
  constructor(operationId: string) {
    super(`Operation ${operationId} was already applied with different content.`);
    this.name = "OperationConflictError";
  }
}

export interface OperationScope {
  now: string;
  operationId: string;
  /** Supplied by the authoritative store, not by the request. */
  revision?: string;
}

export type OperationOutcome = {
  /** `replayed`: an earlier run of this operation already saved it, so nothing changed. */
  status: "applied" | "replayed";
  values: BotState;
  receipt: ApplicationReceipt;
};

export function findReceipt(values: BotState, operationId: string): ApplicationReceipt | undefined {
  return values.receipts?.find((receipt) => receipt.operationId === operationId);
}

/** Receipt identity must be checked before any retry performs I/O. */
export function checkedReceipt(values: BotState, operation: Operation): ApplicationReceipt | undefined {
  if (!OPERATION_ID.test(operation.id)) throw new Error(`"${operation.id}" isn't a usable operation id.`);
  const receipt = findReceipt(values, operation.id);
  if (receipt && (receipt.bodyHash !== operation.bodyHash || receipt.kind !== operation.kind))
    throw new OperationConflictError(operation.id);
  return receipt;
}

/** Only call after the operation's external completion record is durable. The receipt itself never changes. */
export function completeOperation(values: BotState, operation: Operation): BotState {
  if (!checkedReceipt(values, operation)) throw new Error(`Operation ${operation.id} has no receipt.`);
  if (!values.pendingOperations?.includes(operation.id)) return values;
  const pendingOperations = values.pendingOperations.filter((id) => id !== operation.id);
  const { pendingOperations: _pending, ...rest } = values;
  return pendingOperations.length ? { ...rest, pendingOperations } : rest;
}

export interface OperationChange {
  values: BotState;
  notes?: readonly string[];
  skill?: SkillPublication;
  fleet?: ApplicationReceipt["fleet"];
}

export function assertOperationCapacity(values: BotState): void {
  const receipts = values.receipts ?? [];
  const pending = new Set(values.pendingOperations ?? []);
  if (receipts.length >= MAX_RECEIPTS && receipts.every((receipt) => pending.has(receipt.operationId)))
    throw new Error("All application receipts are unresolved. Recover them before applying more changes.");
}

/** Refuse before running the callback if saving it would evict unresolved work. */
function retainedReceipts(values: BotState): ApplicationReceipt[] {
  const receipts = [...(values.receipts ?? [])];
  const pending = new Set(values.pendingOperations ?? []);
  while (receipts.length >= MAX_RECEIPTS) {
    const oldest = receipts.findIndex((receipt) => !pending.has(receipt.operationId));
    if (oldest === -1)
      throw new Error("All application receipts are unresolved. Recover them before applying more changes.");
    receipts.splice(oldest, 1);
  }
  return receipts;
}

function entities(values: BotState): string[] {
  return [
    ...values.bots.flatMap((bot) => [
      `bot:${bot.id}`,
      ...bot.routines.map((routine) => `routine:${routine.id}`),
      ...bot.playbooks.map((playbook) => `playbook:${playbook.id}`),
    ]),
    ...(values.groups ?? []).map((group) => `team:${group.id}`),
    ...(values.presets ?? []).map((preset) => `preset:${preset.id}`),
    ...(values.library?.skills ?? []).map((skill) => `skill:${skill.id}`),
    ...(values.library?.mcpServers ?? []).map((server) => `mcp:${server.id}`),
  ];
}

/** Everything in `after` that `before` lacks. */
export function createdEntities(before: BotState, after: BotState): string[] {
  const known = new Set(entities(before));
  return entities(after).filter((entity) => !known.has(entity));
}

/**
 * Applies an operation once: when `values` already holds its receipt, nothing runs and the receipt comes
 * back. Otherwise `run` makes the changes and the receipt joins the same state, so a caller that saves it
 * in one write can never save the changes without the receipt, or the receipt without the changes.
 * The same id with a different body throws OperationConflictError. Pure: the caller reads and writes.
 */
export function applyOperation(
  values: BotState,
  operation: Operation,
  run: (values: BotState, scope: OperationScope) => OperationChange,
): OperationOutcome {
  const earlier = checkedReceipt(values, operation);
  if (earlier) return { status: "replayed", values, receipt: earlier };
  const receipts = retainedReceipts(values);
  const done = run(values, { now: operation.at, operationId: operation.id });
  const created = createdEntities(values, done.values);
  const receipt: ApplicationReceipt = {
    operationId: operation.id,
    kind: operation.kind,
    bodyHash: operation.bodyHash,
    appliedAt: operation.at,
    created: created.slice(0, MAX_RECEIPT_CREATED),
    createdCount: created.length,
    notes: [...(done.notes ?? [])],
    ...(done.skill ? { skill: done.skill } : {}),
    ...(done.fleet ? { fleet: done.fleet } : {}),
  };
  return {
    status: "applied",
    values: {
      ...done.values,
      receipts: [...receipts, receipt],
      pendingOperations: values.pendingOperations,
      ...(operation.pending
        ? { pendingOperations: [...(values.pendingOperations ?? []), operation.id] }
        : {}),
    },
    receipt,
  };
}
