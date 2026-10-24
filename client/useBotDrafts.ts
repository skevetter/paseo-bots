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
  /** Live: reads the staged drafts at call time, not the last render's snapshot. */
  hasDraft(botId: string): boolean;
  discardDrafts(botId?: string): void;
  /**
   * Saves the staged drafts once. Resolves with that save's result: true when it committed
   * (even if a later draft remains pending or conflicted), false when it failed. Callers that
   * join an in-flight save receive the same result.
   */
  flush(): Promise<boolean>;
  patchBot(botId: string, patch: Partial<Bot>): void;
  updateBot(botId: string, patch: Partial<Bot>, recordHistory?: boolean): Promise<boolean>;
}

interface SaveOutcome {
  ok: boolean;
  acknowledgementBlocked: boolean;
}

interface PersistenceOptions {
  pending: RefObject<BotDrafts>;
  mounted: RefObject<boolean>;
  publish: (next: BotDrafts) => void;
  commit: CommitBotState;
  setConflicts: Dispatch<SetStateAction<Conflicts>>;
}

function useDraftPersistence({ pending, mounted, publish, commit, setConflicts }: PersistenceOptions) {
  const [draftSaving, setSaving] = useState(false);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const captured = useRef<BotDrafts>({});
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reportConflicts = (update: SetStateAction<Conflicts>) => {
    if (mounted.current) setConflicts(update);
  };
  const cancel = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const schedule = () => {
    cancel();
    // No timer may outlive the component: once unmounted, drain the residual drafts now.
    if (mounted.current) timer.current = setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
    else void flushRef.current();
  };
  const save = async (batch: BotDrafts): Promise<SaveOutcome> => {
    const failure: { conflict?: DraftConflict; acknowledgementBlocked: boolean } = {
      acknowledgementBlocked: false,
    };
    let ok = false;
    try {
      ok = await commit(
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
          reportConflicts((current) => {
            const next = { ...current };
            for (const id of Object.keys(batch)) delete next[id];
            return Object.assign(next, acknowledgement.conflicts);
          });
        },
      );
    } catch (error) {
      // A conflicting draft rejects inside its mutate; the conflict is published below, so it is a failed save.
      if (!failure.conflict) throw error;
    }
    const conflict = failure.conflict;
    if (conflict) reportConflicts((current) => ({ ...current, [conflict.botId]: conflict }));
    return { ok, acknowledgementBlocked: failure.acknowledgementBlocked };
  };
  const flush = (): Promise<boolean> => {
    cancel();
    if (inFlight.current) return inFlight.current;
    const batch = pending.current;
    if (Object.keys(batch).length === 0) return Promise.resolve(true);
    captured.current = batch;
    if (mounted.current) setSaving(true);
    const run = save(batch)
      .finally(() => {
        captured.current = {};
        inFlight.current = null;
        if (mounted.current) setSaving(false);
      })
      .then((outcome) => {
        // Failed saves and ACK conflicts stop here; only a clean save continues with residual drafts.
        if (outcome.ok && !outcome.acknowledgementBlocked && Object.keys(pending.current).length) schedule();
        return outcome.ok;
      });
    inFlight.current = run;
    return run;
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void flushRef.current();
    };
  }, [mounted]);
  return { flush, schedule, cancel, captured, inFlight, draftSaving };
}

export function useBotDrafts(
  latest: { readonly current: BotStoreState },
  commit: CommitBotState,
): DraftState {
  const toast = useToast();
  const mounted = useRef(true);
  const [pending, setPending] = useState<BotDrafts>({});
  const pendingRef = useRef<BotDrafts>({});
  const [draftConflicts, setConflicts] = useState<Conflicts>({});
  const publish = (next: BotDrafts) => {
    pendingRef.current = next;
    if (mounted.current) setPending(next);
  };
  const persistence = useDraftPersistence({ pending: pendingRef, mounted, publish, commit, setConflicts });
  const hasPendingDrafts = () => Object.keys(pendingRef.current).length !== 0;
  const hasDraft = (botId: string) => pendingRef.current[botId] !== undefined;
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
    hasDraft,
    discardDrafts,
    flush: persistence.flush,
    patchBot,
    updateBot,
  };
}
