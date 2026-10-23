import { EXECUTION_LABEL, RUN_LABEL } from "../shared/managed-runs";
import type { RoutineRun } from "../shared/rpc";

export interface HostAgentEvidence {
  id: string;
  status: string;
  labels: Record<string, string>;
  pendingPermissions: readonly unknown[];
  activeTurn?: { turnId: string } | null;
  attentionTimestamp?: string | null;
  attentionReason?: string | null;
  lastError?: string;
}
export interface HostTimelineEvidence {
  endCursor: { epoch: string; seq: number } | null;
  error: string | null;
  gap: boolean;
  staleCursor: boolean;
  hasNewer: boolean;
  entries: { seqEnd: number; item: { type: string; clientMessageId?: string; text?: string } }[];
}
export interface HostRunEvidence {
  status: "running" | "waiting_for_user" | "completed" | "failed" | "unknown";
  cursor: { epoch: string; seq: number } | null;
  providerTurnId: string | null;
  output: string | null;
  error: string | null;
}

/** Host turn IDs do not identify an execution. Labels plus the admitted prompt identify this one. */
export function hostRunEvidence(
  run: RoutineRun,
  agent: HostAgentEvidence,
  timeline: HostTimelineEvidence,
): HostRunEvidence {
  const unknown: HostRunEvidence = {
    status: "unknown",
    cursor: timeline.endCursor,
    providerTurnId: null,
    output: null,
    error: null,
  };
  if (!matchingExecution(run, agent)) return unknown;
  if (timeline.error || timeline.gap || timeline.staleCursor || timeline.hasNewer) return unknown;
  const lastPrompt = timeline.entries.findLast((entry) => entry.item.type === "user_message");
  const item = lastPrompt?.item;
  if (
    item?.type !== "user_message" ||
    item.clientMessageId !== (run.managed?.clientMessageId ?? run.executionId)
  )
    return unknown;
  if (agent.pendingPermissions.length > 0) return { ...unknown, status: "waiting_for_user" };
  if (agent.status === "running" || agent.status === "initializing")
    return { ...unknown, status: "running", providerTurnId: agent.activeTurn?.turnId ?? null };
  return terminalEvidence(run, agent, timeline, unknown);
}

function matchingExecution(run: RoutineRun, agent: HostAgentEvidence): boolean {
  return (
    agent.id === run.agentId &&
    agent.labels[RUN_LABEL] === run.id &&
    agent.labels[EXECUTION_LABEL] === run.executionId
  );
}

function terminalEvidence(
  run: RoutineRun,
  agent: HostAgentEvidence,
  timeline: HostTimelineEvidence,
  unknown: HostRunEvidence,
): HostRunEvidence {
  const afterPrompt = timeline.entries.filter(
    (entry) =>
      entry.seqEnd >
      (timeline.entries.findLast((row) => row.item.type === "user_message")?.seqEnd ?? Infinity),
  );
  const at = Date.parse(agent.attentionTimestamp ?? "");
  const startedAt = Date.parse(run.startedAt);
  if (!Number.isFinite(at) || !Number.isFinite(startedAt) || at < startedAt) return unknown;
  if (agent.attentionReason === "error")
    return { ...unknown, status: "failed", error: agent.lastError ?? "Host reported a turn error." };
  if (agent.attentionReason !== "finished") return unknown;
  const reply = afterPrompt.findLast((entry) => entry.item.type === "assistant_message")?.item;
  return {
    ...unknown,
    status: "completed",
    output: reply?.type === "assistant_message" ? (reply.text?.slice(0, 400) ?? null) : null,
  };
}
