import { newMessageId } from "../../sent-attachments";
import type { DraftMessage } from "./draftState";

export type SubmittedMessage = DraftMessage & { messageId: string };

export function submitDraft(draft: DraftMessage): SubmittedMessage {
  return {
    text: draft.text.trim(),
    attachments: draft.attachments,
    messageId: draft.messageId ?? newMessageId(),
  };
}

export function editDraft(
  draft: DraftMessage,
  patch: Partial<Pick<DraftMessage, "text" | "attachments">>,
): DraftMessage {
  const text = patch.text ?? draft.text;
  const attachments = patch.attachments ?? draft.attachments;
  if (text === draft.text && attachments === draft.attachments) return draft;
  return { text, attachments };
}
