import { z } from "zod";
import { findBot } from "../../../shared/changes/refs";
import { PolicyIdSchema, type Resolution, type Source } from "../../../shared/policies";
import { TaskClassSchema } from "../../../shared/task-contract";
import { getPolicy, listPolicies, resolveForBot } from "../../policies";
import { BotRef, type ControlTool, defineControlTool, result } from "../tool";

const sourceText = (source: Source): string =>
  source.policyId ? `${source.layer} (${source.policyId} r${source.revision})` : source.layer;

function resolutionLines(resolution: Resolution): string[] {
  const lines = [
    `provider: ${resolution.provider.value ?? "none"} from ${sourceText(resolution.provider.source)}`,
    `model: ${resolution.model.value ?? "the provider's default"} from ${sourceText(resolution.model.source)}`,
    `thinking: ${resolution.thinkingOptionId.value ?? "the default"} from ${sourceText(resolution.thinkingOptionId.source)}`,
    `mode: ${resolution.modeId.value ?? "the provider's default"} from ${sourceText(resolution.modeId.source)}`,
  ];
  return resolution.ok ? lines : [...lines, ...resolution.issues.map((issue) => `Problem: ${issue.message}`)];
}

const policiesList = defineControlTool({
  name: "policies_list",
  annotations: { readOnlyHint: true },
  description:
    "List the runtime policies: named, versioned bundles of execution settings (which model runs a role, budget, concurrency) that bots and teams inherit. Shows each policy's newest revision.",
  input: z.object({}),
  async run(_input, context) {
    const { policies } = await listPolicies(context.host.store);
    const text = policies.length
      ? policies.map((policy) => `- ${policy.id} r${policy.revision}: ${policy.name}`).join("\n")
      : "No policies yet. Bots use their own settings.";
    return result(text, { policies });
  },
});

const policiesGet = defineControlTool({
  name: "policies_get",
  annotations: { readOnlyHint: true },
  description: "One policy in full. Without a revision, the newest.",
  input: z.object({ id: PolicyIdSchema, revision: z.number().int().min(1).optional() }),
  async run(input, context) {
    const found = await getPolicy(context.host.store, input);
    if (!found.policy)
      throw new Error(`There is no policy ${input.id}${input.revision ? ` r${input.revision}` : ""}.`);
    return result(
      `${found.policy.name}, revision ${found.policy.revision} of ${found.revisions.length}.`,
      found,
    );
  },
});

const policyResolve = defineControlTool({
  name: "policy_resolve",
  annotations: { readOnlyHint: true },
  description:
    "What a bot, or one of its routines, runs with: provider, model, thinking level, approval mode and limits, each with the layer it came from (global, team, bot policy, the bot's own, the routine's), and any problem that would stop a chat from starting.",
  input: z.object({
    bot: BotRef,
    routine: z.string().min(1).max(100).optional().describe("A routine's id on that bot."),
    task_class: TaskClassSchema.optional().describe("Checks that the policy allows this class of work."),
  }),
  async run({ bot: ref, routine, task_class }, context) {
    const bot = findBot(await context.host.values(), ref);
    const { resolution } = await resolveForBot(context.host, {
      bot: bot.id,
      routineId: routine,
      taskClass: task_class,
    });
    return result(`${bot.name} runs with:\n${resolutionLines(resolution).join("\n")}`, {
      bot: bot.id,
      resolution,
    });
  },
});

export const POLICY_TOOLS: readonly ControlTool[] = [policiesList, policiesGet, policyResolve];
