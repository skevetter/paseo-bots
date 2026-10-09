import { z } from "zod";
import { applyChanges, resolveChanges } from "../../shared/changes/apply";
import { botDetails, setupOverview } from "../../shared/changes/overview";
import { ChangesSchema } from "../../shared/changes/schema";
import { proposalReply } from "../../shared/proposals";
import { applyContext } from "../apply-context";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

export const getSetup = defineTool({
  name: "get_setup",
  description:
    "Read the bot setup on this Paseo: the bots, teams, the library of skills and MCP servers, connected apps, what new bots start with, presets, and the providers with their models and approval modes. Name a bot to get everything about it, including its instructions, playbooks and routines. Read it before propose_changes.",
  input: z.object({
    bot: z.string().max(100).optional().describe("A bot's name or id, for its full details."),
  }),
  async run({ bot }, { host }) {
    const values = await host.values();
    if (bot) return botDetails(values, bot);
    const context = await applyContext(host);
    return setupOverview(values, context.providers ?? null, context.accounts ?? null);
  },
});

export const proposeChanges = defineTool({
  name: "propose_changes",
  description:
    "Propose changes to the bot setup: create, edit or delete bots (name, instructions, model, approval mode, avatar, skills, MCP servers, connected apps, tool grants, playbooks, routines), teams (members, Chief of Staff, shared instructions, logo), library skills and MCP servers, what new bots start with, and presets. Put every change for one request in one call, in order; later changes can refer to bots and teams created earlier by name. The user reviews them together on a card in this chat and applies or dismisses them. Read get_setup first for the current setup and valid ids.",
  input: z.object({
    summary: z.string().min(1).max(300).describe("One line saying what the changes do, shown on the card."),
    changes: ChangesSchema,
  }),
  async run({ summary, changes }, { bot, agentId, host }) {
    const values = await host.values();
    const context = await applyContext(host);
    const resolved = resolveChanges(changes, context);
    const notes: string[] = [];
    // A dry run finds mistakes now, while they can still be fixed; the app applies the changes for real.
    applyChanges(values, resolved, { ...context, notes });
    const proposal = await createProposal({
      botId: bot.id,
      agentId,
      kind: "changes",
      data: { summary: summary.trim(), changes: resolved, provider: context.provider, notes },
    });
    const reply = proposalReply(
      proposal.id,
      changes.length === 1 ? "the change" : `these ${changes.length} changes`,
    );
    return [reply, ...notes].join(" ");
  },
});
