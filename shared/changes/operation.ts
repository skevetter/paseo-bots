import type { BotState } from "../bot";
import { OPERATION_ID } from "./ids";
import { type ApplicationReceipt, MAX_RECEIPT_CREATED, MAX_RECEIPTS } from "./receipt";

/** One request to change the setup. The caller makes the id and hashes the body; nothing here reads a clock. */
export interface Operation {
  id: string;
  kind: string;
  /** Of everything that decides what the operation does, so a reused id with other content is caught. */
  bodyHash: string;
  /** What the operation counts as the time it ran, which its changes stamp on what they make. */
  at: string;
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
  run: (values: BotState, scope: OperationScope) => { values: BotState; notes?: readonly string[] },
): OperationOutcome {
  if (!OPERATION_ID.test(operation.id)) throw new Error(`"${operation.id}" isn't a usable operation id.`);
  const earlier = findReceipt(values, operation.id);
  if (earlier) {
    if (earlier.bodyHash !== operation.bodyHash) throw new OperationConflictError(operation.id);
    return { status: "replayed", values, receipt: earlier };
  }
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
  };
  return {
    status: "applied",
    values: { ...done.values, receipts: [...(values.receipts ?? []), receipt].slice(-MAX_RECEIPTS) },
    receipt,
  };
}
