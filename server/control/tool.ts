import { type ZodType, z } from "zod";
import type { Bot, BotState, ControlSettings } from "../../shared/bot";
import { applyChanges, resolveChanges } from "../../shared/changes/apply";
import { findBot } from "../../shared/changes/refs";
import type { Change } from "../../shared/changes/schema";
import { elevations } from "../../shared/elevated";
import type { Proposal } from "../../shared/proposals";
import { applyContext } from "../apply-context";
import type { CommandAllowlist } from "../commands";
import type { BotsHost } from "../host";
import type { MemoryJournal } from "../journal";
import { createProposal } from "../proposals";
import type { Relay } from "../relay";
import type { RoutineScheduler } from "../scheduler";
import type { McpTool, ToolResult } from "../tools/mcp";

export interface ControlContext {
  host: BotsHost;
  relay: Relay;
  scheduler: RoutineScheduler;
  journal: MemoryJournal;
  commands: CommandAllowlist;
  settings(): Promise<ControlSettings>;
}

export type ControlTool = McpTool<ControlContext>;

export function defineControlTool<Schema extends ZodType>(
  tool: McpTool<ControlContext, Schema>,
): ControlTool {
  return tool as unknown as ControlTool;
}

export const BotRef = z.string().min(1).max(100).describe("The bot's name or id.");

export const Confirm = z.literal(true).describe("Must be true. It can't be undone.");

export function result(text: string, data: Record<string, unknown>): ToolResult {
  return { text, data };
}

export async function botByRef(context: ControlContext, ref: string): Promise<Bot> {
  return findBot(await context.host.values(), ref);
}

export const APPROVAL_PLACE = "Settings > Bots > External control in Paseo";

/** Waits for the user unless "Allow elevated changes without approval" is on. */
export async function needsApproval(context: ControlContext, reasons: readonly string[]): Promise<boolean> {
  return reasons.length > 0 && !(await context.settings()).allowElevated;
}

export function pendingResult(proposal: Proposal, reasons: readonly string[]): ToolResult {
  return result(
    `Waiting for approval: proposal ${proposal.id}. ${reasons.join(" ")} Accept it under ${APPROVAL_PLACE}.`,
    { status: "pending", proposal: proposal.id, reasons },
  );
}

export type ChangeOutcome =
  | { status: "applied"; values: BotState }
  | { status: "pending"; result: ToolResult };

/** The same changes the app's setup cards apply. Elevated ones wait in a proposal. */
export async function applyOrPropose(
  context: ControlContext,
  summary: string,
  changes: readonly Change[],
): Promise<ChangeOutcome> {
  const apply = await applyContext(context.host);
  const resolved = resolveChanges(changes, apply);
  const before = await context.host.values();
  const reasons = elevations(before, applyChanges(before, resolved, apply), apply.modes);
  if (await needsApproval(context, reasons)) {
    const proposal = await createProposal({
      botId: "",
      agentId: "",
      origin: "control",
      kind: "changes",
      data: { summary, changes: resolved, provider: apply.provider },
    });
    return { status: "pending", result: pendingResult(proposal, reasons) };
  }
  const saved = await context.host.store.update((values) => applyChanges(values, resolved, apply));
  return { status: "applied", values: saved.values };
}
