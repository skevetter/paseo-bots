import { describe, expect, it, vi } from "vitest";
import { ASKED_BY_LABEL, askBot, checkChat } from "../server/tools/bots";
import { answerMcp } from "../server/tools/mcp";
import { EMPTY_LIBRARY } from "../shared/bot";
import { buildAgentConfig } from "../shared/bot-agent";

import { defined, fakeHost, makeBot } from "./helpers";

interface FakeChat {
  status: string;
  labels: Record<string, string>;
  title?: string;
  reply?: string;
  pendingPermissions?: unknown[];
}

function fakePaseo(chats: Record<string, FakeChat>) {
  return {
    agents: {
      ref: (id: string) => ({
        refresh: async () => {
          const chat = chats[id];
          return chat
            ? {
                agent: {
                  id,
                  status: chat.status,
                  labels: chat.labels,
                  title: chat.title ?? null,
                  pendingPermissions: chat.pendingPermissions ?? [],
                  lastError: null,
                },
              }
            : null;
        },
        waitForFinish: async () => {
          const chat = defined(chats[id], `chat ${id}`);
          if (chat.status === "running") {
            chat.status = "idle";
            chat.reply ??= "Done.";
          }
          return { status: "idle", final: null, error: null, lastMessage: chat.reply ?? null };
        },
        timeline: {
          refetch: async () => {
            const reply = chats[id]?.reply;
            return {
              entries: [
                { item: { type: "user_message", text: "question" } },
                ...(reply ? [{ item: { type: "assistant_message", text: reply } }] : []),
              ],
            };
          },
        },
      }),
    },
  } as never;
}

const checkableChats: Record<string, FakeChat> = {
  asked: {
    status: "running",
    title: "Scout: count",
    labels: { "paseo-bots.bot": "bot-inbox", "paseo-bots.asked-by": "bot-scout" },
  },
  waiting: {
    status: "idle",
    title: "Scout: send",
    labels: { "paseo-bots.bot": "bot-inbox", "paseo-bots.asked-by": "bot-scout" },
    pendingPermissions: [{}],
  },
  mine: {
    status: "idle",
    title: "Invoices",
    labels: { "paseo-bots.bot": "bot-scout" },
    reply: "Sent.",
  },
  theirs: { status: "idle", labels: { "paseo-bots.bot": "bot-inbox" } },
};

describe("asking other bots", () => {
  it("prevents nested requests and requests by disabled colleagues", async () => {
    const scout = makeBot({ id: "bot-scout", name: "Scout" });
    const host = fakeHost([scout]);
    host.attach(
      fakePaseo({
        "caller-chat": {
          status: "running",
          labels: { "paseo-bots.bot": scout.id, [ASKED_BY_LABEL]: "bot-inbox" },
        },
      }),
    );
    const caller = { bot: scout, agentId: "caller-chat", host, relay: null as never };
    expect(await askBot.available?.(caller)).toBe(false);
    expect(await askBot.available?.({ ...caller, bot: { ...scout, contactBots: "off" } })).toBe(false);
    await expect(askBot.run({ bot: "bot-inbox", message: "x" }, caller)).rejects.toThrow();
  });

  it("checks only the bot's own chats and the ones it asked", async () => {
    const scout = makeBot({ id: "bot-scout", name: "Scout" });
    const host = fakeHost([scout, makeBot({ id: "bot-inbox", name: "Inbox" })]);
    host.attach(fakePaseo(checkableChats));
    const caller = { bot: scout, agentId: "x", host, relay: null as never };
    expect(await checkChat.run({ chat_id: "asked" }, caller)).toBe(
      '"Scout: count": Inbox is still working in chat asked. Use check_chat with that id for the answer.',
    );
    expect(await checkChat.run({ chat_id: "asked", wait: true }, caller)).toBe(
      '"Scout: count": Inbox answered (chat asked):\n\nDone.',
    );
    expect(await checkChat.run({ chat_id: "waiting" }, caller)).toContain(
      "waiting for the user to approve something",
    );
    expect(await checkChat.run({ chat_id: "mine" }, caller)).toBe(
      '"Invoices": You answered (chat mine):\n\nSent.',
    );
    await expect(checkChat.run({ chat_id: "theirs" }, caller)).rejects.toThrow("only check your own chats");
    await expect(checkChat.run({ chat_id: "nope" }, caller)).rejects.toThrow("no chat with that id");
  });

  it("pre-approves asking only when the user allowed it", () => {
    const tools = { type: "http" as const, url: "http://127.0.0.1:1/bots/b/a", headers: {} };
    const granted = (contactBots: "ask" | "allow" | "off") =>
      buildAgentConfig(makeBot({ contactBots }), {
        library: EMPTY_LIBRARY,
        model: "m",
        systemPrompt: "",
        plugin: { tools },
      }).toolPolicy?.preapproved.map((grant) => grant.tool) ?? [];
    expect(granted("allow")).toContain("ask_bot");
    expect(granted("ask")).not.toContain("ask_bot");
    expect(granted("ask")).toContain("check_chat");
  });
});

describe("tools a bot isn't offered", () => {
  it("won't run ask_bot for a bot kept from contacting others, even when called by name", async () => {
    const scout = makeBot({ id: "bot-scout", name: "Scout", contactBots: "off" });
    const host = fakeHost([scout, makeBot({ id: "bot-inbox", name: "Inbox" })]);
    host.attach(
      fakePaseo({ "caller-chat": { status: "running", labels: { "paseo-bots.bot": "bot-scout" } } }),
    );
    const create = vi.fn();
    host.bindChatStarts({ create });
    const answer = await answerMcp(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask_bot", arguments: { bot: "Inbox", message: "hi" } },
      },
      { name: "paseo-bots", tools: [askBot] },
      { bot: scout, agentId: "caller-chat", host, relay: null as never },
    );
    expect(answer?.error?.code).toBe(-32602);
    expect(create).not.toHaveBeenCalled();
  });
});
