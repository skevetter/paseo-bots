import type { Bot } from "../../../shared/bot";
import { RUN_LABEL } from "../../../shared/managed-runs";
import type { PaseoAgent } from "../../paseo";

export type ConversationKind = "new" | "loading" | "legacy" | "remote" | "managed";

export function conversationKind({
  agentId,
  agent,
  agentReady,
  isLocal,
}: {
  agentId: string | null;
  agent?: Pick<PaseoAgent, "id" | "labels"> | null;
  agentReady: boolean;
  isLocal: boolean;
}): ConversationKind {
  if (agentId === null) return "new";
  if (!agentReady || agent?.id !== agentId || !agent.labels) return "loading";
  if (Object.hasOwn(agent.labels, RUN_LABEL)) return "managed";
  return isLocal ? "legacy" : "remote";
}

export function startsNewTask(kind: ConversationKind, bot: Pick<Bot, "executionMode">, isLocal: boolean) {
  return kind === "managed" || (kind === "new" && isLocal && bot.executionMode === "managed");
}

export function conversationNotice(kind: ConversationKind, isLocal: boolean, nextManaged: boolean): string {
  if (kind === "loading")
    return "Waiting for this conversation's agent details. Sending is disabled until its execution mode is known.";
  if (kind === "managed")
    return isLocal
      ? "Managed task record. Start new task sends only your new message and attachments to a separate task using the bot's current execution settings. It does not continue this conversation or copy its history; existing work is unchanged."
      : "Managed task record on another host. Start new task starts separately on that host without copying history. Local managed accounting, budgets and Memory Bridge are unavailable.";
  if (!isLocal)
    return "Remote manual execution: local managed accounting, budgets and Memory Bridge are unavailable. Messages use the selected host.";
  if (kind === "legacy")
    return nextManaged
      ? "Legacy conversation: replies continue here without managed admission or accounting. The bot's managed opt-in applies only to new tasks."
      : "Legacy conversation: replies continue here without managed admission or accounting.";
  return nextManaged
    ? "New managed task: durable admission and capacity reservation before launch. Routing, Memory Bridge and in-flight spend caps are not enabled by this setting."
    : "New legacy chat: no managed admission, accounting or enforcement.";
}
