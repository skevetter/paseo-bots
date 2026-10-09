import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BotState } from "../../../shared/bot";
import { describeChange } from "../../../shared/changes/describe";
import { proposalElevations } from "../../../shared/elevated";
import type { Proposal } from "../../../shared/proposals";
import { describeSchedule } from "../../../shared/routines";
import { applyContext } from "../../apply-context";
import { acceptProposal, createProposal, dismissProposal, getProposal, listProposals } from "../../proposals";
import {
  APPROVAL_PLACE,
  BotRef,
  botByRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  maskedConfig,
  maskValues,
  needsApproval,
  pendingResult,
  result,
} from "../tool";

const ProposalId = z
  .string()
  .regex(/^p-[a-z0-9]+$/)
  .describe("The proposal's id, like p-0123456789.");

/** MCP env and header values stay on this host; only their names show. */
function withoutSecrets(proposal: Proposal): Proposal["data"] {
  switch (proposal.kind) {
    case "changes":
      return {
        ...proposal.data,
        changes: proposal.data.changes.map((change) =>
          change.type === "add_mcp_server"
            ? {
                ...change,
                env: change.env && maskValues(change.env),
                headers: change.headers && maskValues(change.headers),
              }
            : change,
        ),
      };
    case "import":
      return {
        ...proposal.data,
        bots: proposal.data.bots.map((entry) => ({
          ...entry,
          mcpServers: entry.mcpServers.map((server) => ({ ...server, config: maskedConfig(server.config) })),
        })),
      };
    default:
      return proposal.data;
  }
}

function describeProposal(proposal: Proposal): string {
  switch (proposal.kind) {
    case "skill":
      return `Skill ${proposal.data.name}: ${proposal.data.description}`;
    case "routine":
      return `Routine ${proposal.data.name}: ${describeSchedule(proposal.data.schedule)}`;
    case "changes": {
      const described = proposal.data.changes.map(describeChange).join("; ");
      return proposal.data.summary === described ? described : `${proposal.data.summary}: ${described}`;
    }
    case "command":
      return `Always allow \`${proposal.data.command}\` in ${proposal.data.cwd}`;
    case "import":
      return `${proposal.data.summary}: ${[
        ...proposal.data.bots.map((entry) => entry.bot.name),
        ...proposal.data.teams.map((team) => `team ${team.name}`),
      ].join(", ")}`;
  }
}

function summary(proposal: Proposal, values: BotState) {
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    origin: proposal.origin,
    botId: proposal.botId,
    bot: values.bots.find((bot) => bot.id === proposal.botId)?.name ?? null,
    createdAt: proposal.createdAt,
    resolvedAt: proposal.resolvedAt,
    description: describeProposal(proposal),
  };
}

async function existing(id: string): Promise<Proposal> {
  const proposal = await getProposal(id);
  if (!proposal) throw new Error("This proposal is no longer available.");
  return proposal;
}

async function reasonsFor(context: ControlContext, proposal: Proposal): Promise<string[]> {
  const { modes } = await applyContext(context.host);
  return proposalElevations(proposal, await context.host.values(), modes);
}

const list = defineControlTool({
  name: "proposals_list",
  description:
    "Lists proposals for skills, routines, setup changes, allowed commands and imports, newest first.",
  input: z.object({
    status: z.enum(["pending", "accepted", "dismissed"]).default("pending"),
    origin: z
      .enum(["chat", "control"])
      .optional()
      .describe(
        "chat: a bot proposed it in a chat. control: an external control tool did. Both when left out.",
      ),
  }),
  annotations: { readOnlyHint: true },
  async run(filter, context) {
    const values = await context.host.values();
    const proposals = (await listProposals(filter)).map((proposal) => summary(proposal, values));
    const lines = proposals.map((entry) => `${entry.id} (${entry.kind}): ${entry.description}`);
    return result(lines.length ? lines.join("\n") : `No ${filter.status} proposals.`, { proposals });
  },
});

const get = defineControlTool({
  name: "proposals_get",
  description: "Shows one proposal in full, with what accepting it would allow that needs approval.",
  input: z.object({ id: ProposalId }),
  annotations: { readOnlyHint: true },
  async run({ id }, context) {
    const proposal = await existing(id);
    const reasons = proposal.status === "pending" ? await reasonsFor(context, proposal) : [];
    const entry = summary(proposal, await context.host.values());
    return result(`${entry.id} (${entry.kind}, ${entry.status}): ${entry.description}`, {
      ...entry,
      data: withoutSecrets(proposal),
      elevations: reasons,
    });
  },
});

const accept = defineControlTool({
  name: "proposals_accept",
  description:
    "Accepts a pending proposal, as its card's button in the app does. Elevated ones need the user unless they allow elevated changes.",
  input: z.object({ id: ProposalId }),
  async run({ id }, context) {
    const reasons = await reasonsFor(context, await existing(id));
    if (await needsApproval(context, reasons))
      throw new Error(`${reasons.join(" ")} Accept it under ${APPROVAL_PLACE}.`);
    const accepted = await acceptProposal(id, { store: context.host.store, commands: context.commands });
    return result(`Accepted ${describeProposal(accepted.proposal)}.`, {
      proposal: summary(accepted.proposal, await context.host.values()),
      ...(accepted.skill ? { skill: accepted.skill } : {}),
    });
  },
});

const dismiss = defineControlTool({
  name: "proposals_dismiss",
  description: "Dismisses a pending proposal without applying it.",
  input: z.object({ id: ProposalId }),
  async run({ id }, context) {
    const proposal = await dismissProposal(id);
    return result(`Dismissed ${describeProposal(proposal)}.`, {
      proposal: summary(proposal, await context.host.values()),
    });
  },
});

const commandsList = defineControlTool({
  name: "commands_list",
  description: "Lists the commands a bot runs without asking, each matched exactly in its folder.",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot: ref }, context) {
    const bot = await botByRef(context, ref);
    const rules = await context.commands.list(bot.id);
    const lines = rules.map((rule) => `${rule.id}: \`${rule.command}\` in ${rule.cwd}`);
    return result(lines.length ? lines.join("\n") : `${bot.name} has no allowed commands.`, {
      bot: bot.id,
      rules,
    });
  },
});

const commandsAllow = defineControlTool({
  name: "commands_allow",
  description:
    "Lets a bot run one exact command in one folder without asking. It needs the user's approval unless they allow elevated changes.",
  input: z.object({
    bot: BotRef,
    command: z.string().min(1).max(16_384).describe("The full command line, matched exactly."),
    cwd: z
      .string()
      .min(1)
      .max(1000)
      .refine(isAbsolute, "Give an absolute path.")
      .describe("The absolute folder it runs in."),
  }),
  async run({ bot: ref, command, cwd }, context) {
    const bot = await botByRef(context, ref);
    const reasons = [`${bot.name} runs \`${command}\` in ${cwd} without asking.`];
    if (await needsApproval(context, reasons)) {
      const proposal = await createProposal({
        botId: bot.id,
        agentId: "",
        origin: "control",
        kind: "command",
        data: { command, cwd },
      });
      return pendingResult(proposal, reasons);
    }
    const rule = await context.commands.add(bot.id, command, cwd);
    return result(`${bot.name} now runs \`${command}\` in ${cwd} without asking.`, {
      status: "applied",
      bot: bot.id,
      rule,
    });
  },
});

const commandsRemove = defineControlTool({
  name: "commands_remove",
  description: "Removes an allowed command, so the bot asks before running it again.",
  input: z.object({
    bot: BotRef,
    id: z.string().min(1).max(100).describe("The rule's id from commands_list."),
    confirm: Confirm,
  }),
  annotations: { destructiveHint: true },
  async run({ bot: ref, id }, context) {
    const bot = await botByRef(context, ref);
    if (!(await context.commands.remove(bot.id, id)))
      throw new Error(`${bot.name} has no allowed command with id ${id}.`);
    return result(`${bot.name} asks before running that command again.`, { bot: bot.id, removed: id });
  },
});

export const PROPOSAL_TOOLS: readonly ControlTool[] = [
  list,
  get,
  accept,
  dismiss,
  commandsList,
  commandsAllow,
  commandsRemove,
];
