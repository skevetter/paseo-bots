import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAttachment } from "../../../shared/attachments";
import { getDraft, loadDrafts, setDraft } from "./drafts";

export interface DraftMessage {
  text: string;
  attachments: ComposerAttachment[];
}

export interface ComposerDraftState {
  text: string;
  attachments: ComposerAttachment[];
  latest: RefObject<DraftMessage>;
  updateText(next: string): void;
  updateAttachments(update: (current: ComposerAttachment[]) => ComposerAttachment[]): void;
}

export function useComposerDraft(draftKey: string): ComposerDraftState {
  const initial = useMemo(() => getDraft(draftKey), [draftKey]);
  const [text, setText] = useState(initial?.text ?? "");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(initial?.attachments ?? []);
  const touched = useRef(false);
  const latest = useRef<DraftMessage>({ text, attachments });
  latest.current = { text, attachments };

  const updateText = (next: string) => {
    touched.current = true;
    setText(next);
  };
  const updateAttachments = (update: (current: ComposerAttachment[]) => ComposerAttachment[]) => {
    touched.current = true;
    setAttachments(update);
  };

  // Phones read drafts from AsyncStorage after the first render; apply it unless the user already typed.
  useEffect(() => {
    let alive = true;
    void loadDrafts().then(() => {
      if (!alive || touched.current) return;
      const draft = getDraft(draftKey);
      if (draft) {
        setText(draft.text);
        setAttachments(draft.attachments);
      }
    });
    return () => {
      alive = false;
    };
  }, [draftKey]);

  useEffect(() => {
    if (touched.current) setDraft(draftKey, { text, attachments });
  }, [draftKey, text, attachments]);

  return { text, attachments, latest, updateText, updateAttachments };
}
