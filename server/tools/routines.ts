import { z } from "zod";
import { proposalReply } from "../../shared/proposals";
import { describeSchedule, ScheduleInput, scheduleFrom, upcomingRuns } from "../../shared/routines";
import { newSchedulePolicy, SchedulePolicySchema } from "../../shared/schedule-policy";
import { createProposal } from "../proposals";
import { defineTool } from "./mcp";

export const proposeRoutine = defineTool({
  name: "propose_routine",
  description:
    "Propose a routine: instructions you'll carry out on a schedule (or when a webhook is called), each run in its own new chat. The user confirms it on a card in this chat, and each run's result is posted back here. New schedules save an explicit IANA timezone and daylight-saving policy; specify schedule_policy to choose them.",
  input: z.object({
    name: z.string().min(1).max(80).describe('A short name, like "Morning inbox check".'),
    instructions: z
      .string()
      .min(1)
      .max(20_000)
      .describe("What to do on each run, written so it works without this chat."),
    schedule: ScheduleInput,
    schedule_policy: SchedulePolicySchema.optional(),
  }),
  async run({ name, instructions, schedule, schedule_policy }, { bot, agentId }) {
    const now = new Date();
    const parsed = scheduleFrom(schedule, now);
    const policy = schedule_policy ?? newSchedulePolicy();
    const proposal = await createProposal({
      botId: bot.id,
      agentId,
      kind: "routine",
      data: {
        name: name.trim(),
        prompt: instructions.trim(),
        schedule: parsed,
        schedulePolicy: policy,
        resultsChatId: agentId,
      },
    });
    const next = upcomingRuns(parsed, now, now, { count: 1, policy })[0];
    const when =
      parsed.kind === "webhook"
        ? "It runs when its webhook is called; the URL is in the routine's settings."
        : `${describeSchedule(parsed, policy)}${next ? `, first on ${next.toLocaleString()}` : ""}.`;
    return `${proposalReply(proposal.id, `the routine "${name.trim()}"`)} ${when}`;
  },
});
