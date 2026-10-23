import type { RpcInput } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { z } from "zod";
import {
  automationsApplyRpc,
  automationsListRpc,
  automationsPreviewRpc,
  automationsRevertRpc,
  automationsRunNowRpc,
} from "../shared/automations";
import { listAutomations } from "./automation-catalog";
import { applyAutomationChange, previewAutomationChange, revertAutomationChange } from "./automation-changes";
import type { BotsHost } from "./host";
import { registerRunDetails } from "./run-details";
import type { RoutineScheduler } from "./scheduler";

export async function runAutomationNow(
  scheduler: Pick<RoutineScheduler, "runNow">,
  input: RpcInput<typeof automationsRunNowRpc>,
): Promise<z.output<typeof automationsRunNowRpc.output>> {
  const { botId, routineId, requestId } = automationsRunNowRpc.input.parse(input);
  // The scheduler checks the durable request receipt before resolving current mutable bot settings.
  return scheduler.runNow(botId, routineId, requestId);
}

/** Composition owns this call; registering services never starts a hidden model chat. */
export function registerAutomations(
  server: PluginServerContext,
  host: BotsHost,
  scheduler: RoutineScheduler,
): void {
  server.handle(automationsListRpc, (input, context) => {
    host.attach(context.paseo);
    return listAutomations(host, scheduler.coordinator, input);
  });
  server.handle(automationsPreviewRpc, (input, context) => {
    host.attach(context.paseo);
    return previewAutomationChange(host, input);
  });
  server.handle(automationsApplyRpc, (input, context) => {
    host.attach(context.paseo);
    return applyAutomationChange(host, input);
  });
  server.handle(automationsRevertRpc, (input, context) => {
    host.attach(context.paseo);
    return revertAutomationChange(host, input);
  });
  server.handle(automationsRunNowRpc, (input, context) => {
    host.attach(context.paseo);
    return runAutomationNow(scheduler, input);
  });
  registerRunDetails(server, host, scheduler.coordinator);
}
