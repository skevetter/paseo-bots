import { z } from "zod";
import { BOT_LABEL } from "../../../shared/bot";
import { displayTitle, SETUP_PROMPT } from "../../../shared/chat";
import { expandLearn } from "../../../shared/skills";
import { fullTimeline } from "../../../shared/timeline";
import { chatTranscript } from "../../../shared/transcript";
import { startChat } from "../../chats";
import { chatStatus, readChat } from "../../tools/bots";
import {
  BotRef,
  botByRef,
  Confirm,
  type ControlContext,
  type ControlTool,
  defineControlTool,
  result,
} from "../tool";

const ChatRef = z.string().min(1).max(100).describe("The chat id chats_start or chats_list gave you.");

function ownerOf(chatId: string, labels: Record<string, string> | null | undefined): string {
  const owner = labels?.[BOT_LABEL];
  if (!owner) throw new Error(`Chat ${chatId} isn't a bot's chat, so control can't use it.`);
  return owner;
}

/** Control only drives chats that belong to a bot. */
async function botChat(context: ControlContext, chatRef: string) {
  const paseo = context.host.requirePaseo();
  const chatId = chatRef.trim();
  const snapshot = await paseo.agents
    .ref(chatId)
    .refresh()
    .catch(() => null);
  const agent = snapshot?.agent;
  if (!agent) throw new Error("There's no chat with that id.");
  return { paseo, chatId, agent, botId: ownerOf(chatId, agent.labels) };
}

const start = defineControlTool({
  name: "chats_start",
  description:
    "Start a new chat with a bot, the way the app does: in the bot's workspace, with its tools and settings. Give a prompt, or set setup to run the setup interview.",
  input: z.object({
    bot: BotRef,
    prompt: z.string().min(1).max(20_000).optional().describe("The first message."),
    setup: z
      .boolean()
      .optional()
      .describe("Start the setup interview the bot's panel offers instead of a prompt."),
  }),
  async run({ bot: ref, prompt, setup }, context) {
    if (setup && prompt) throw new Error("Give a prompt or set setup, not both.");
    const text = setup ? SETUP_PROMPT : prompt?.trim();
    if (!text) throw new Error("Give a prompt, or set setup to true for the setup interview.");
    const bot = await botByRef(context, ref);
    // Like the app: no title, so Paseo names the chat from its first message.
    const chatId = await startChat(context.host, context.relay, bot, { prompt: text, title: "", labels: {} });
    return result(`Started chat ${chatId} with ${bot.name}.`, { chat: chatId, bot: bot.id });
  },
});

const list = defineControlTool({
  name: "chats_list",
  description: "List a bot's chats, newest activity first: id, title, status and last activity.",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot: ref }, context) {
    const paseo = context.host.requirePaseo();
    const bot = await botByRef(context, ref);
    const { entries } = await paseo.agents.list({ filter: { labels: { [BOT_LABEL]: bot.id } } });
    const chats = entries
      .map((entry) => entry.agent)
      .filter((agent) => !agent.archivedAt)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((agent) => ({
        id: agent.id,
        title: displayTitle(agent.title),
        status: chatStatus(agent),
        lastActivity: agent.updatedAt,
      }));
    const lines = chats.map((chat) => `- ${chat.title} (${chat.id}): ${chat.status}, ${chat.lastActivity}`);
    return result(chats.length ? lines.join("\n") : `${bot.name} has no chats.`, { bot: bot.id, chats });
  },
});

const send = defineControlTool({
  name: "chats_send",
  description:
    "Send a message to a bot's chat. While the bot is working, the message steers its current turn, or with interrupt, ends that turn and starts a new one.",
  input: z.object({
    chat: ChatRef,
    message: z.string().min(1).max(20_000),
    interrupt: z
      .boolean()
      .optional()
      .describe("While it's working, end its current turn instead of steering it."),
  }),
  async run({ chat, message, interrupt = false }, context) {
    const { paseo, chatId } = await botChat(context, chat);
    const typed = message.trim();
    await paseo.agents
      .ref(chatId)
      .send(expandLearn(typed) ?? typed, { activeTurnBehavior: interrupt ? "interrupt" : "steer" });
    return result(`Sent to chat ${chatId}.`, { chat: chatId });
  },
});

const read = defineControlTool({
  name: "chats_read",
  description:
    "Read a bot's chat: its status and full transcript, or with last_reply, only the bot's latest answer.",
  input: z.object({
    chat: ChatRef,
    last_reply: z.boolean().optional().describe("Return only the bot's latest answer."),
  }),
  annotations: { readOnlyHint: true },
  async run({ chat, last_reply: lastReply = false }, context) {
    const paseo = context.host.requirePaseo();
    const chatId = chat.trim();
    const state = await readChat(paseo, chatId);
    const botId = ownerOf(chatId, state.labels);
    const title = displayTitle(state.title);
    const base = { chat: chatId, bot: botId, title, status: state.state, error: state.error };
    if (lastReply)
      return result(state.reply.trim() || `No reply yet (${state.state}).`, { ...base, reply: state.reply });
    const transcript = chatTranscript({
      title,
      botName: (await context.host.bot(botId))?.name ?? "Bot",
      entries: await fullTimeline(paseo, chatId),
      exportedAt: new Date(),
    });
    return result(transcript, { ...base, transcript });
  },
});

const stop = defineControlTool({
  name: "chats_stop",
  description:
    "Stop a bot's current turn, like the app's stop button. Paseo lets this end a turn only while it waits for a permission; otherwise use chats_send with interrupt.",
  input: z.object({ chat: ChatRef }),
  async run({ chat }, context) {
    const { paseo, chatId, agent } = await botChat(context, chat);
    const permission = agent.pendingPermissions?.[0];
    if (!permission) {
      if (chatStatus(agent) !== "running")
        return result(`Chat ${chatId} isn't working.`, { chat: chatId, stopped: false });
      throw new Error(
        `Chat ${chatId} is working without waiting on a permission, and Paseo can't stop that turn from here. Use chats_send with interrupt to redirect it.`,
      );
    }
    await paseo.agents.ref(chatId).respondToPermission({
      requestId: permission.id,
      response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." },
    });
    return result(`Stopped chat ${chatId}.`, { chat: chatId, stopped: true });
  },
});

const archive = defineControlTool({
  name: "chats_archive",
  description: "Archive a bot's chat. It leaves the bot's chat list and its pin.",
  input: z.object({ chat: ChatRef, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ chat }, context) {
    const { paseo, chatId } = await botChat(context, chat);
    await paseo.agents.ref(chatId).archive();
    await context.host.store.update((values) =>
      values.ui?.pinnedChats.some((pin) => pin.chatId === chatId)
        ? {
            ...values,
            ui: { ...values.ui, pinnedChats: values.ui.pinnedChats.filter((pin) => pin.chatId !== chatId) },
          }
        : values,
    );
    return result(`Archived chat ${chatId}.`, { chat: chatId, archived: true });
  },
});

export const CHAT_TOOLS: readonly ControlTool[] = [start, list, send, read, stop, archive];
