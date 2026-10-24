import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAttachment } from "../../../shared/attachments";
import { getDraft, loadDrafts, setDraft } from "./drafts";
import { editDraft } from "./submission";

export interface DraftMessage {
  text: string;
  attachments: ComposerAttachment[];
  messageId?: string;
}

export interface ComposerDraftState {
  text: string;
  attachments: ComposerAttachment[];
  latest: RefObject<DraftMessage>;
  updateText(next: string): void;
  updateAttachments(update: (current: ComposerAttachment[]) => ComposerAttachment[]): void;
  replace(next: DraftMessage): void;
}

export function useComposerDraft(draftKey: string): ComposerDraftState {
  const initial = useMemo(() => getDraft(draftKey), [draftKey]);
  const [draft, setState] = useState<DraftMessage>(initial ?? { text: "", attachments: [] });
  const touched = useRef(false);
  const latest = useRef(draft);

  const replace = (next: DraftMessage) => {
    if (next === latest.current) return;
    touched.current = true;
    latest.current = next;
    setState(next);
  };
  const updateText = (text: string) => replace(editDraft(latest.current, { text }));
  const updateAttachments = (update: (current: ComposerAttachment[]) => ComposerAttachment[]) =>
    replace(editDraft(latest.current, { attachments: update(latest.current.attachments) }));

  // Phones read drafts from AsyncStorage after the first render; apply it unless the user already typed.
  useEffect(() => {
    let alive = true;
    void loadDrafts().then(() => {
      if (!alive || touched.current) return;
      const draft = getDraft(draftKey);
      if (draft) {
        latest.current = draft;
        setState(draft);
      }
    });
    return () => {
      alive = false;
    };
  }, [draftKey]);

  useEffect(() => {
    if (touched.current) setDraft(draftKey, draft);
  }, [draftKey, draft]);

  return { ...draft, latest, updateText, updateAttachments, replace };
}
