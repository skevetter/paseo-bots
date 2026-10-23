import { createHash, randomUUID } from "node:crypto";
import { BOT_LABEL, EMPTY_LIBRARY } from "../shared/bot";
import { buildAgentConfig } from "../shared/bot-agent";
import type { PreparedBotChat } from "../shared/chat";
import { resolveBot } from "../shared/policies";
import { PURPOSE_LABEL } from "../shared/runs";
import { makeBot } from "./helpers";

export function makePrepared(patch: Partial<PreparedBotChat> = {}): PreparedBotChat {
  const bot = makeBot({
    id: patch.botId ?? "bot-1",
    provider: patch.provider ?? "omp",
    model: patch.model ?? "frozen-model",
  });
  const prompt = patch.prompt ?? "Review the inbox without changing external data.";
  const systemPrompt = "Use only the admitted tools. Report observed evidence.";
  const config = buildAgentConfig(bot, {
    library: EMPTY_LIBRARY,
    model: bot.model ?? "frozen-model",
    systemPrompt,
  });
  return {
    version: 1,
    agentId: randomUUID(),
    idempotencyKey: randomUUID(),
    botId: bot.id,
    botName: bot.name,
    hostId: null,
    purpose: "task",
    provider: bot.provider,
    model: bot.model ?? "frozen-model",
    placement: { path: "/tmp/paseo-coordinator-fixture", projectRoot: null },
    config,
    prompt,
    labels: { [BOT_LABEL]: bot.id, [PURPOSE_LABEL]: patch.purpose ?? "task" },
    metadata: {
      resolvedPolicy: resolveBot({}, bot),
      permissionEnvelope: {
        modeId: bot.modeId,
        alwaysAllow: [],
        contactBots: bot.contactBots,
        mcpServerNames: [],
        apps: [],
        appRules: {},
      },
      systemPromptHash: createHash("sha256").update(systemPrompt).digest("hex"),
      userPromptHash: createHash("sha256").update(prompt).digest("hex"),
      memoryContextReceipt: null,
      playbooks: [],
      inputArtifactRefs: [],
      environmentVersion: "fixture-environment-v1",
    },
    ...patch,
  };
}
