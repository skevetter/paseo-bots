import type { ComposerAttachment } from "../shared/attachments";
import { prefixedId } from "../shared/uuid";

// Paseo's timeline keeps only the text of user messages, so attachments sent from here are remembered for the session.
interface Sent {
  messageId: string;
  text: string;
  attachments: ComposerAttachment[];
}

const sent: Sent[] = [];

export function rememberSent(messageId: string, text: string, attachments: ComposerAttachment[]): void {
  if (attachments.length > 0) sent.push({ messageId, text, attachments });
}

/** Matches by message id, then by text for providers that assign their own ids. */
export function sentAttachments(item: {
  text: string;
  messageId?: string;
  clientMessageId?: string;
}): ComposerAttachment[] {
  const ids = [item.messageId, item.clientMessageId].filter(Boolean);
  return (
    (
      sent.find((entry) => ids.includes(entry.messageId)) ??
      sent.find((entry) => entry.text === item.text.trim())
    )?.attachments ?? []
  );
}

export function newMessageId(): string {
  return prefixedId("msg", 6);
}
