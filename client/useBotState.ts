import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { BotState, StateSnapshot } from "../shared/bot";
import { stateReadRpc, stateWriteRpc } from "../shared/rpc";
import { errorText } from "./native";
import { showSaved, stateQuery } from "./state-query";

export type BotStoreState = (
  | { status: "loading" }
  | { status: "error"; error: string }
  | ({ status: "ready" } & StateSnapshot)
) & {
  saving: boolean;
  saveError: string | null;
  /** Saves the whole document over `revision`. Never throws. */
  save(values: BotState, revision: string): Promise<boolean>;
  reload(): Promise<void>;
};

function useBotStoreState(): BotStoreState {
  const read = useRpc(stateReadRpc);
  const write = useRpc(stateWriteRpc);
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const query = useQuery(stateQuery(() => read({})));

  const save = async (values: BotState, revision: string) => {
    setSaving(true);
    try {
      const result = await write({ revision, values });
      if (result.status === "conflict") {
        setSaveError(result.error);
        return false;
      }
      await showSaved(queryClient, { revision: result.revision, values: result.values });
      setSaveError(null);
      return true;
    } catch (error) {
      setSaveError(errorText(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const shared = { saving, saveError, save, reload: async () => void (await query.refetch()) };
  if (query.data) return { status: "ready", ...query.data, ...shared };
  if (query.error) return { status: "error", error: errorText(query.error), ...shared };
  return { status: "loading", ...shared };
}

type SaveOutcome = "saved" | "conflict" | "unavailable";

async function saveOnce(
  current: BotStoreState,
  mutate: (values: BotState) => BotState,
): Promise<SaveOutcome> {
  if (current.status !== "ready") return "unavailable";
  if (await current.save(mutate(current.values), current.revision)) {
    // Let the hook render the new revision before the next queued write reads it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return "saved";
  }
  await current.reload();
  await new Promise((resolve) => setTimeout(resolve, 50));
  return "conflict";
}

export type CommitBotState = (mutate: (values: BotState) => BotState) => Promise<boolean>;

/**
 * Writes queue, read the latest revision when they run and retry on a conflict, so autosaves,
 * menu actions and the other plugin surface never overwrite each other.
 */
export function useBotState() {
  const settings = useBotStoreState();
  const toast = useToast();
  const latest = useRef(settings);
  latest.current = settings;
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const commit: CommitBotState = (mutate) => {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const outcome = await saveOnce(latest.current, mutate);
        if (outcome !== "conflict") return outcome === "saved";
      }
      toast.error(latest.current.saveError ?? "Couldn't save bots. Try again.");
      return false;
    };
    const result = queue.current.then(run);
    queue.current = result.catch(() => false);
    return result;
  };

  return { settings, latest, commit };
}
