import { toWire } from "../../../shared/attachments";
import { expandLearn } from "../../../shared/skills";
import type { OutgoingMessage } from "../../ChatPane";
import type { BotHost } from "../../data";
import type { PaseoAgentSendOptions } from "../../paseo";
import { rememberSent } from "../../sent-attachments";
import type { ConversationKind } from "./execution";
import { activeTurnBehaviorFor, type SendBehavior } from "./logic";
import type { SubmittedMessage } from "./submission";

export interface DeliveryTarget {
  agentId: string | null;
  kind: ConversationKind;
  host: BotHost;
  sendBehavior: SendBehavior;
  onStart(message: OutgoingMessage): Promise<void>;
}

export async function deliverMessage(
  message: SubmittedMessage,
  { agentId, kind, host, sendBehavior, onStart }: DeliveryTarget,
) {
  if (!host.api || kind === "loading")
    throw new Error("Agent details or host connection unavailable. Try again after the conversation loads.");
  const continuing = kind === "legacy" || kind === "remote";
  const typed = message.text.trim();
  // Only continuations have the existing session's /learn command context.
  const outgoing =
    (continuing && host.isLocal ? expandLearn(typed) : null) ?? (typed || "See the attached files.");
  const messageId = message.messageId;
  const wire = toWire(message.attachments);
  rememberSent(messageId, outgoing, message.attachments);
  if (!continuing) {
    await onStart({ text: outgoing, messageId, ...wire });
    return;
  }
  if (!agentId) throw new Error("No conversation selected.");
  const options = {
    messageId,
    activeTurnBehavior: activeTurnBehaviorFor(sendBehavior),
    images: wire.images,
    attachments: wire.attachments,
  } as PaseoAgentSendOptions;
  await host.api.agents.ref(agentId).send(outgoing, options);
}
