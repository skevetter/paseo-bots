import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { lastTurn, logLine } from "../shared/activity";
import { isReviewEligible, settleTurn } from "../shared/runs";
import type { BotChat, BotsHost } from "./host";
import type { MemoryJournal } from "./journal";
import { appendDailyLog } from "./memory";

export async function turnStarted(
  host: BotsHost,
  journal: MemoryJournal,
  { agent, turnId }: PluginLifecycleEvents["agent.turn_started"],
): Promise<void> {
  const botId = await host.botIdOf(agent.id);
  if (botId)
    await journal.begin(botId, { id: agent.id, title: agent.title?.trim() || "Untitled chat" }, turnId);
}

export async function turnEnded(
  host: BotsHost,
  journal: MemoryJournal,
  { agent, turnId, outcome, timeline }: PluginLifecycleEvents["agent.turn_ended"],
  knownChat?: BotChat | null,
): Promise<void> {
  const chat = knownChat === undefined ? await host.chatOf(agent.id) : knownChat;
  if (!chat) return;
  const { botId } = chat;
  const title = chat.title?.trim() || agent.title?.trim() || "Untitled chat";
  await journal.end(botId, { id: agent.id, title }, turnId);
  const { reply, tools } = lastTurn(timeline);
  // The daily log is what later reviews read, so only a task turn that reached an end belongs in it.
  if (!isReviewEligible({ purpose: chat.purpose, ...settleTurn(outcome.kind) })) return;
  const line = logLine({
    at: new Date(),
    chat: title,
    reply,
    tools,
    failure: outcome.kind === "failed" ? outcome.error.message : null,
  });
  if (line) await appendDailyLog(botId, line);
}
