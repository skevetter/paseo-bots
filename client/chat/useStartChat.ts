import { useRpc } from "@getpaseo/plugin/client";
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import type { Bot, Library } from "../../shared/bot";
import { launchPreparedBotChat, prepareBotChat } from "../../shared/chat";
import {
  chatsStartRpc,
  type LocalChatInput,
  LocalChatInputSchema,
  type LocalChatStartResult,
  LocalChatStartResultSchema,
} from "../../shared/local-start";
import type { PolicyState } from "../../shared/policies";
import { ensureBotHomeRpc, systemPromptRpc } from "../../shared/rpc";
import type { Purpose } from "../../shared/runs";
import { newUuid } from "../../shared/uuid";
import type { OutgoingMessage } from "../ChatPane";
import type { BotHost } from "../data";
import { useMountedRef } from "./composer/mounted";
import { type ChatStartFeedback, matchesStartOrigin } from "./LocalStartNotice";
import { flushLocalStartSettings, type LocalStartSettings } from "./localStartSettings";

export interface StartChatOptions extends LocalStartSettings {
  bot: Bot;
  library: Library;
  policy: PolicyState;
  host: BotHost;
  onStarted(chatId: string): void;
  feedback: ChatStartFeedback;
}

export type StartChat = (message: OutgoingMessage, purpose?: Purpose) => Promise<void>;

function useRemoteStart({ bot, library, policy, host }: StartChatOptions) {
  const ensureHome = useRpc(ensureBotHomeRpc);
  const compose = useRpc(systemPromptRpc);
  return async (message: OutgoingMessage, purpose: Purpose): Promise<string> => {
    if (!host.api) throw new Error(`${host.label} is offline.`);
    const home = await ensureHome({ botId: bot.id });
    const placement = bot.cwd
      ? { path: bot.cwd, projectRoot: null }
      : { path: home.path, projectRoot: home.root };
    const { systemPrompt } = await compose({ bot, local: false, message: message.text });
    const prepared = await prepareBotChat(host.api, {
      bot,
      library,
      policy,
      agentId: newUuid(),
      idempotencyKey: `paseo-bots:${message.messageId}`,
      plugin: {},
      placement,
      purpose,
      prompt: message.text,
      systemPrompt,
      images: message.images,
      attachments: message.attachments,
      clientMessageId: message.messageId,
    });
    return launchPreparedBotChat(host.api, prepared);
  };
}

function useLocalStart(
  { bot, host, feedback, flush, hasDraft }: StartChatOptions,
  isCurrent: () => boolean,
  openCreated: (agentId: string) => boolean,
) {
  const create = useRpc(chatsStartRpc);
  const receive = (input: LocalChatInput, result: LocalChatStartResult) => {
    feedback.report(host, input, result);
    if (result.status === "created" && result.agentId) {
      if (openCreated(result.agentId)) feedback.dismiss(host, input);
      return;
    }
    if (result.status === "not_created" || result.mode === "legacy")
      throw new Error(
        result.message ?? "Creation is unconfirmed. Check the existing request before retrying.",
      );
  };
  return async (message: OutgoingMessage, purpose: Purpose): Promise<void> => {
    const input = LocalChatInputSchema.parse({
      botId: bot.id,
      requestId: message.messageId,
      clientMessageId: message.messageId,
      prompt: message.text,
      purpose,
      images: message.images,
      attachments: message.attachments,
    });
    const previous = feedback.find(host, input);
    // Acknowledged requests replay their frozen admission, not later draft settings.
    if (!previous?.result || (previous.result.mode === "legacy" && previous.result.status === "not_created"))
      await flushLocalStartSettings({ flush, hasDraft }, bot.id, isCurrent);
    if (!isCurrent()) throw new Error("The bot host changed. Select the origin host before retrying.");
    feedback.report(host, input, previous?.result ?? null);
    const result = LocalChatStartResultSchema.parse(await create(input));
    receive(input, result);
  };
}

export function useStartChat(options: StartChatOptions): StartChat {
  const { bot, host, feedback } = options;
  const queryClient = useQueryClient();
  const mounted = useMountedRef();
  const latest = useRef(options);
  latest.current = options;
  const isCurrent = () =>
    mounted.current && latest.current.bot.id === bot.id && matchesStartOrigin(host, latest.current.host);
  const openCreated = (agentId: string) => {
    if (!isCurrent()) return false;
    latest.current.onStarted(agentId);
    return true;
  };
  const local = useLocalStart(options, isCurrent, openCreated);
  const remote = useRemoteStart(options);
  return async (message, purpose = "task") => {
    if (!host.api) throw new Error(`${host.label} is offline.`);
    if (host.isLocal) await local(message, purpose);
    else {
      const id = await remote(message, purpose);
      if (!openCreated(id))
        feedback.reportCreated({ origin: host, botId: bot.id, requestId: message.messageId, agentId: id });
    }
    void queryClient.invalidateQueries(
      { queryKey: ["paseo-bots", "chats", host.key, bot.id] },
      { throwOnError: false },
    );
  };
}
