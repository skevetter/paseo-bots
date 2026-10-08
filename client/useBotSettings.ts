import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import { type BotSettingsValues, botSettings } from "../shared/bot";

export type BotSettingsState = ReturnType<typeof useBotSettingsState>;

function useBotSettingsState() {
  return useSettings(botSettings);
}

type SaveOutcome = "saved" | "conflict" | "unavailable";

async function saveOnce(
  current: BotSettingsState,
  mutate: (values: BotSettingsValues) => BotSettingsValues,
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

export type CommitBotSettings = (
  mutate: (values: BotSettingsValues) => BotSettingsValues,
) => Promise<boolean>;

/**
 * Writes queue, read the latest revision when they run and retry on a conflict, so autosaves,
 * menu actions and the other plugin surface never overwrite each other.
 */
export function useBotSettings() {
  const settings = useBotSettingsState();
  const toast = useToast();
  const latest = useRef(settings);
  latest.current = settings;
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const commit: CommitBotSettings = (mutate) => {
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
