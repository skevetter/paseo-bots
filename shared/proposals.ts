import { z } from "zod";
import { ImportedBotSchema, RoutineScheduleSchema, TeamFileTeamSchema } from "./bot";
import { botToolName } from "./bot-tools";
import { ChangeSchema } from "./changes/schema";
import { toolCallName } from "./tool-name";

const ProposalBase = z.object({
  id: z.string(),
  /** The bot it's for; empty when it isn't about one bot. */
  botId: z.string(),
  /** The chat the proposal came from; empty for external control. */
  agentId: z.string(),
  origin: z.enum(["chat", "control"]).default("chat"),
  status: z.enum(["pending", "accepted", "dismissed"]),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
});

/** `name` is the folder name; `text` the full SKILL.md. */
const SkillProposalSchema = z.object({ name: z.string(), description: z.string(), text: z.string() });

const RoutineProposalSchema = z.object({
  name: z.string(),
  prompt: z.string(),
  schedule: RoutineScheduleSchema,
  resultsChatId: z.string().nullable(),
});

/** `provider` is the host's pick for new bots the defaults leave open. */
const ChangesProposalSchema = z.object({
  summary: z.string(),
  changes: z.array(ChangeSchema),
  provider: z.string().default(""),
});

/** An always-allowed command, matched exactly. */
const CommandProposalSchema = z.object({ command: z.string(), cwd: z.string() });

/** Bots and teams read from a file, whose memory and skill files are already written. */
const ImportProposalSchema = z.object({
  summary: z.string(),
  bots: z.array(ImportedBotSchema),
  teams: z.array(TeamFileTeamSchema),
});

export const ProposalSchema = z.discriminatedUnion("kind", [
  ProposalBase.extend({ kind: z.literal("skill"), data: SkillProposalSchema }),
  ProposalBase.extend({ kind: z.literal("routine"), data: RoutineProposalSchema }),
  ProposalBase.extend({ kind: z.literal("changes"), data: ChangesProposalSchema }),
  ProposalBase.extend({ kind: z.literal("command"), data: CommandProposalSchema }),
  ProposalBase.extend({ kind: z.literal("import"), data: ImportProposalSchema }),
]);
export type Proposal = z.infer<typeof ProposalSchema>;

const PROPOSAL_ID = /\bproposal (p-[a-z0-9]{10})\b/i;

/** The card finds the proposal id in this reply. */
export function proposalReply(id: string, what: string): string {
  return `Proposal ${id}: the user sees ${what} as a card in this chat and decides whether to save it. Don't save it yourself.`;
}

/** The output is text or MCP content blocks. */
function proposalIdIn(output: unknown): string | null {
  const text = typeof output === "string" ? output : JSON.stringify(output ?? null);
  return PROPOSAL_ID.exec(text)?.[1] ?? null;
}

const PROPOSING_TOOLS: readonly string[] = ["propose_skill", "propose_routine", "propose_changes"];

export function proposalIdOf(call: {
  name: string;
  status: string;
  detail: unknown;
  metadata?: unknown;
}): string | null {
  const tool = botToolName(toolCallName(call));
  if (call.status !== "completed" || !tool || !PROPOSING_TOOLS.includes(tool)) return null;
  const detail = call.detail as { output?: unknown } | null;
  return proposalIdIn(detail && typeof detail === "object" && "output" in detail ? detail.output : null);
}
