import { useToast } from "@getpaseo/plugin/client/react-native";
import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Bot } from "../shared/bot";
import {
  acknowledgeDrafts,
  applyDrafts,
  type BotDrafts,
  type DraftConflict,
  DraftConflictError,
  stageDrafts,
} from "./bot-drafts";
import type { BotStoreState, CommitBotState } from "./useBotState";

const SAVE_DELAY_MS = 600;
type Conflicts = Record<string, DraftConflict>;

export interface DraftState {
  drafts: Record<string, Bot>;
  draftSaving: boolean;
  draftConflicts: Conflicts;
  hasPendingDrafts(): boolean;
  discardDrafts(botId?: string): void;
  flush(): Promise<void>;
  patchBot(botId: string, patch: Partial<Bot>): void;
  updateBot(botId: string, patch: Partial<Bot>, recordHistory?: boolean): Promise<boolean>;
}

function useDraftPersistence(
  pending: RefObject<BotDrafts>,
  publish: (next: BotDrafts) => void,
  commit: CommitBotState,
  setConflicts: Dispatch<SetStateAction<Conflicts>>,
) {
  const [draftSaving, setSaving] = useState(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const captured = useRef<BotDrafts>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const schedule = () => {
    cancel();
    timer.current = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
  };
  const flush = (): Promise<void> => {
    cancel();
    if (inFlight.current) return inFlight.current;
    const batch = pending.current;
    if (Object.keys(batch).length === 0) return Promise.resolve();
    captured.current = batch;
    setSaving(true);
    const write = async () => {
      const failure: { conflict?: DraftConflict; acknowledgementBlocked?: boolean } = {};
      const ok = await commit(
        (values) => {
          try {
            return applyDrafts(values, batch);
          } catch (error) {
            if (error instanceof DraftConflictError) failure.conflict = error.conflict;
            throw error;
          }
        },
        (saved) => {
          const acknowledgement = acknowledgeDrafts(pending.current, batch, saved.values);
          failure.acknowledgementBlocked = Object.keys(acknowledgement.conflicts).length > 0;
          publish(acknowledgement.drafts);
          setConflicts((current) => {
            const next = { ...current };
            for (const id of Object.keys(batch)) delete next[id];
            return Object.assign(next, acknowledgement.conflicts);
          });
        },
      );
      const conflict = failure.conflict;
      if (conflict) setConflicts((current) => ({ ...current, [conflict.botId]: conflict }));
      if (ok && !failure.acknowledgementBlocked && Object.keys(pending.current).length) schedule();
    };
    inFlight.current = write().finally(() => {
      captured.current = {};
      inFlight.current = null;
      setSaving(false);
    });
    return inFlight.current;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [],
  );
  return { flush, schedule, cancel, captured, inFlight, draftSaving };
}

export function useBotDrafts(
  latest: { readonly current: BotStoreState },
  commit: CommitBotState,
): DraftState {
  const toast = useToast();
  const [pending, setPending] = useState<BotDrafts>({});
  const pendingRef = useRef<BotDrafts>({});
  const [draftConflicts, setConflicts] = useState<Conflicts>({});
  const publish = (next: BotDrafts) => {
    pendingRef.current = next;
    setPending(next);
  };
  const persistence = useDraftPersistence(pendingRef, publish, commit, setConflicts);
  const hasPendingDrafts = () => Object.keys(pendingRef.current).length !== 0;
  const patchBot = (botId: string, patch: Partial<Bot>, recordHistory = true) => {
    const existing = pendingRef.current[botId];
    const base =
      existing?.value ??
      (latest.current.status === "ready"
        ? latest.current.values.bots.find((bot) => bot.id === botId)
        : undefined);
    if (!base) return false;
    publish(
      stageDrafts(pendingRef.current, base, patch, {
        recordHistory,
        inFlight: persistence.captured.current[botId],
      }),
    );
    persistence.schedule();
    return true;
  };
  const updateBot = async (botId: string, patch: Partial<Bot>, recordHistory = false) => {
    const earlier = persistence.inFlight.current;
    if (earlier) await earlier;
    if (!patchBot(botId, patch, recordHistory)) return false;
    await persistence.flush();
    if (!hasPendingDrafts()) return true;
    toast.error("Unsaved bot edits remain. Retry saving, or discard them and review the saved bot.");
    return false;
  };
  const discardDrafts = (botId?: string) => {
    if (persistence.inFlight.current) return;
    const next = { ...pendingRef.current };
    if (botId) delete next[botId];
    else for (const id of Object.keys(next)) delete next[id];
    publish(next);
    setConflicts((current) => {
      const next = { ...current };
      if (botId) delete next[botId];
      else return {};
      return next;
    });
    if (!hasPendingDrafts()) persistence.cancel();
  };
  const drafts = useMemo(
    () => Object.fromEntries(Object.entries(pending).map(([id, draft]) => [id, draft.value])),
    [pending],
  );
  return {
    drafts,
    draftSaving: persistence.draftSaving,
    draftConflicts,
    hasPendingDrafts,
    discardDrafts,
    flush: persistence.flush,
    patchBot,
    updateBot,
  };
}
