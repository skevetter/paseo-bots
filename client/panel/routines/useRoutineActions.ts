import { useRpc } from "@getpaseo/plugin/client";
import { copyText, type ToastApi, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { Routine } from "../../../shared/bot";
import { type RoutineRun, routineRunNowRpc, routineWebhookRpc } from "../../../shared/rpc";
import { confirmDialog, errorText } from "../../native";
import type { PanelProps } from "../BotPanel";
import { type RunStart, type RunStarts, withRunStart } from "./runs";

export interface RoutineActions {
  /** Run now calls in flight or failed, by routine id. */
  starts: RunStarts;
  setRoutines(routines: Routine[]): void;
  update(id: string, patch: Partial<Routine>): void;
  /** `lastRunId`: the routine's latest run; a failure shows until a newer one is recorded. */
  run(routine: Routine, lastRunId: string | null): Promise<void>;
  copyWebhook(routine: Routine): Promise<void>;
  remove(routine: Routine): Promise<void>;
}

function showRunOutcome(toast: ToastApi, routine: Routine, botName: string, started: RoutineRun) {
  if (started.status === "running")
    toast.show(`Started "${routine.name}". It appears as a chat under ${botName}.`, {
      variant: "success",
    });
  else if (started.status === "skipped-busy")
    toast.show(`"${routine.name}" is still working on its last run.`);
  else toast.error(started.error ?? "Couldn't start the run.");
}

export function useRoutineActions({
  bot,
  onPatch,
  flush,
}: Pick<PanelProps, "bot" | "onPatch" | "flush">): RoutineActions {
  const runNow = useRpc(routineRunNowRpc);
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [starts, setStarts] = useState<RunStarts>({});
  const mark = (id: string, start: RunStart | null) =>
    setStarts((current) => withRunStart(current, id, start));

  const setRoutines = (routines: Routine[]) => onPatch({ routines });
  const update = (id: string, patch: Partial<Routine>) =>
    setRoutines(bot.routines.map((routine) => (routine.id === id ? { ...routine, ...patch } : routine)));

  const run = async (routine: Routine, lastRunId: string | null) => {
    mark(routine.id, { status: "starting" });
    try {
      await flush();
      const { run: started } = await runNow({ botId: bot.id, routineId: routine.id });
      mark(routine.id, null);
      showRunOutcome(toast, routine, bot.name, started);
      void queryClient.invalidateQueries({ queryKey: ["paseo-bots"] });
    } catch (error) {
      mark(routine.id, { status: "failed", error: errorText(error), lastRunId });
    }
  };

  const copyWebhook = async (routine: Routine) => {
    try {
      await flush();
      await copyText((await webhook({ routineId: routine.id })).url);
      toast.show("Webhook URL copied", { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const remove = async (routine: Routine) => {
    const confirmed = await confirmDialog({
      title: "Delete routine",
      message: `Delete "${routine.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed) setRoutines(bot.routines.filter((entry) => entry.id !== routine.id));
  };

  return { starts, setRoutines, update, run, copyWebhook, remove };
}
