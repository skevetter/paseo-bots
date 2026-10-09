import { afterEach, describe, expect, it } from "vitest";
import { CHAT_TOOLS } from "../server/control/tools/chats";
import { BOT_LABEL, DEFAULT_BOT_LIST_UI } from "../shared/bot";
import { TOOLS_MCP_NAME } from "../shared/bot-tools";
import { SETUP_PROMPT } from "../shared/chat";
import { startControl } from "./control-helpers";
import { defined, makeBot, useTempPaseoHome } from "./helpers";

interface FakeChat {
  status: string;
  labels: Record<string, string>;
  title?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  reply?: string;
  pendingPermissions?: { id: string }[];
}

interface Created {
  agentId: string;
  prompt: string;
  title?: string;
  labels: Record<string, string>;
  config: { mcpServers?: Record<string, { type: string; url?: string; headers?: Record<string, string> }> };
}

function fakePaseo(chats: Record<string, FakeChat>) {
  const created: Created[] = [];
  const sent: { chat: string; text: string; options: unknown }[] = [];
  const answered: { chat: string; options: unknown }[] = [];
  const workspace = {
    current: () => ({ projectId: "p", projectRootPath: "/bots" }),
    refresh: async () => ({ projectId: "p", projectRootPath: "/bots" }),
    setTitle: async () => undefined,
    archive: async () => undefined,
    agents: {
      create: async (options: Created) => {
        created.push(options);
        chats[options.agentId] = { status: "running", labels: options.labels, title: options.title };
        return { id: options.agentId };
      },
    },
  };
  const snapshot = (id: string, chat: FakeChat) => ({
    id,
    status: chat.status,
    labels: chat.labels,
    title: chat.title ?? null,
    updatedAt: chat.updatedAt ?? "2026-10-01T00:00:00.000Z",
    archivedAt: chat.archivedAt ?? null,
    pendingPermissions: chat.pendingPermissions ?? [],
    lastError: null,
  });
  const entries = (id: string) => {
    const reply = chats[id]?.reply;
    return [
      {
        seqStart: 1,
        seqEnd: 1,
        timestamp: "2026-10-01T00:00:00.000Z",
        item: { type: "user_message", text: "question" },
      },
      ...(reply
        ? [
            {
              seqStart: 2,
              seqEnd: 2,
              timestamp: "2026-10-01T00:01:00.000Z",
              item: { type: "assistant_message", text: reply },
            },
          ]
        : []),
    ];
  };
  const api = {
    projects: { list: async () => ({ projects: [] }) },
    workspaces: {
      list: async () => ({ entries: [] }),
      ref: () => workspace,
      open: async () => workspace,
      create: async () => workspace,
    },
    providers: {
      snapshot: async () => ({
        entries: [{ provider: "claude", models: [{ id: "sonnet", isDefault: true }] }],
      }),
    },
    config: { get: async () => ({ config: {} }) },
    agents: {
      list: async ({ filter }: { filter: { labels: Record<string, string> } }) => ({
        entries: Object.entries(chats)
          .filter(([, chat]) =>
            Object.entries(filter.labels).every(([key, value]) => chat.labels[key] === value),
          )
          .map(([id, chat]) => ({ agent: snapshot(id, chat) })),
      }),
      ref: (id: string) => ({
        refresh: async () => {
          const chat = chats[id];
          return chat ? { agent: snapshot(id, chat) } : null;
        },
        send: async (text: string, options: unknown) => {
          sent.push({ chat: id, text, options });
        },
        respondToPermission: async (options: unknown) => {
          answered.push({ chat: id, options });
          defined(chats[id]).status = "idle";
        },
        archive: async () => {
          const chat = defined(chats[id]);
          chat.archivedAt = "2026-10-02T00:00:00.000Z";
          return { archivedAt: chat.archivedAt };
        },
        timeline: {
          refetch: async () => ({ entries: entries(id), hasOlder: false, startCursor: null, error: null }),
        },
      }),
    },
  };
  return { api: api as never, created, sent, answered };
}

const BOT_LABEL_CHAT = (botId: string) => ({ [BOT_LABEL]: botId });

const running: { stop(): Promise<void> }[] = [];

async function control(chats: Record<string, FakeChat> = {}, attach = true) {
  const started = await startControl(CHAT_TOOLS, {
    bots: [makeBot({ id: "bot-1", name: "Inbox" }), makeBot({ id: "bot-2", name: "Writer" })],
  });
  running.push(started);
  const paseo = fakePaseo(chats);
  if (attach) started.context.host.attach(paseo.api);
  return { ...started, paseo };
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

describe("starting and listing bot chats", () => {
  useTempPaseoHome("paseo-bots-control-chats-");

  it("fail until Paseo is attached", async () => {
    const { call } = await control({}, false);
    const listed = await call("chats_list", { bot: "Inbox" });
    expect(listed.isError).toBe(true);
    expect(listed.text).toContain("Open Paseo once since the daemon started");
    expect((await call("chats_start", { bot: "Inbox", prompt: "hi" })).text).toContain("Open Paseo once");
  });

  it("starts a chat the way the app does, with the bot's label and relay tools", async () => {
    const { call, paseo } = await control();
    const started = await call("chats_start", { bot: "Inbox", prompt: "Plan my week" });
    expect(started.isError).toBe(false);
    const chatId = String(started.data.chat);
    const created = defined(paseo.created[0]);
    expect(created.agentId).toBe(chatId);
    expect(created.prompt).toBe("Plan my week");
    expect(created.labels).toEqual(BOT_LABEL_CHAT("bot-1"));
    expect(created.title).toBeUndefined();

    const tools = defined(created.config.mcpServers?.[TOOLS_MCP_NAME]);
    expect(tools.url).toContain(`/bots/bot-1/${chatId}`);
    const ping = await fetch(defined(tools.url), {
      method: "POST",
      headers: { authorization: defined(tools.headers?.Authorization), "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(ping.status).toBe(200);
  });

  it("starts the setup interview and needs a prompt otherwise", async () => {
    const { call, paseo } = await control();
    expect((await call("chats_start", { bot: "bot-2", setup: true })).isError).toBe(false);
    expect(defined(paseo.created[0]).prompt).toBe(SETUP_PROMPT);
    expect((await call("chats_start", { bot: "Inbox" })).isError).toBe(true);
    expect((await call("chats_start", { bot: "Inbox", prompt: "hi", setup: true })).isError).toBe(true);
    expect(paseo.created).toHaveLength(1);
  });

  it("lists a bot's live chats, newest first", async () => {
    const { call } = await control({
      old: {
        status: "idle",
        labels: BOT_LABEL_CHAT("bot-1"),
        title: "[Inbox] Old",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      fresh: {
        status: "running",
        labels: BOT_LABEL_CHAT("bot-1"),
        title: "Fresh",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
      gone: { status: "idle", labels: BOT_LABEL_CHAT("bot-1"), archivedAt: "2026-09-05T00:00:00.000Z" },
      other: { status: "idle", labels: BOT_LABEL_CHAT("bot-2") },
    });
    const listed = await call("chats_list", { bot: "Inbox" });
    expect(listed.data.chats).toEqual([
      { id: "fresh", title: "Fresh", status: "running", lastActivity: "2026-10-01T00:00:00.000Z" },
      { id: "old", title: "Old", status: "idle", lastActivity: "2026-09-01T00:00:00.000Z" },
    ]);
  });
});

describe("driving a bot chat", () => {
  useTempPaseoHome("paseo-bots-control-chat-");

  it("sends to a bot chat, steering by default and interrupting on request", async () => {
    const { call, paseo } = await control({ chat: { status: "running", labels: BOT_LABEL_CHAT("bot-1") } });
    await call("chats_send", { chat: "chat", message: "  Also check email " });
    await call("chats_send", { chat: "chat", message: "Stop that", interrupt: true });
    expect(paseo.sent).toEqual([
      { chat: "chat", text: "Also check email", options: { activeTurnBehavior: "steer" } },
      { chat: "chat", text: "Stop that", options: { activeTurnBehavior: "interrupt" } },
    ]);
  });

  it("reads the last reply or the whole transcript", async () => {
    const { call } = await control({
      chat: { status: "idle", labels: BOT_LABEL_CHAT("bot-1"), title: "Week", reply: "Here's the plan." },
    });
    const last = await call("chats_read", { chat: "chat", last_reply: true });
    expect(last.text).toBe("Here's the plan.");
    expect(last.data).toMatchObject({ status: "idle", title: "Week", bot: "bot-1" });

    const full = await call("chats_read", { chat: "chat" });
    expect(full.text).toContain("# Week");
    expect(full.text).toContain("### Inbox");
    expect(full.text).toContain("question");
    expect(full.text).toContain("Here's the plan.");
  });

  it("stops a turn waiting on a permission, and says when it can't", async () => {
    const { call, paseo } = await control({
      waiting: { status: "running", labels: BOT_LABEL_CHAT("bot-1"), pendingPermissions: [{ id: "perm-1" }] },
      busy: { status: "running", labels: BOT_LABEL_CHAT("bot-1") },
      idle: { status: "idle", labels: BOT_LABEL_CHAT("bot-1") },
    });
    expect((await call("chats_stop", { chat: "waiting" })).data.stopped).toBe(true);
    expect(paseo.answered).toEqual([
      {
        chat: "waiting",
        options: {
          requestId: "perm-1",
          response: { behavior: "deny", interrupt: true, message: "Interrupted by the user." },
        },
      },
    ]);
    const busy = await call("chats_stop", { chat: "busy" });
    expect(busy.isError).toBe(true);
    expect(busy.text).toContain("chats_send with interrupt");
    expect((await call("chats_stop", { chat: "idle" })).data.stopped).toBe(false);
    expect(paseo.answered).toHaveLength(1);
  });

  it("archives only with confirm, and drops the chat's pin", async () => {
    const chats = { chat: { status: "idle", labels: BOT_LABEL_CHAT("bot-1") } as FakeChat };
    const { call, store } = await control(chats);
    await store.update((values) => ({
      ...values,
      ui: {
        ...DEFAULT_BOT_LIST_UI,
        ...values.ui,
        pinnedChats: [
          { botId: "bot-1", chatId: "chat" },
          { botId: "bot-2", chatId: "x" },
        ],
      },
    }));
    expect((await call("chats_archive", { chat: "chat" })).isError).toBe(true);
    expect(chats.chat.archivedAt).toBeUndefined();

    expect((await call("chats_archive", { chat: "chat", confirm: true })).isError).toBe(false);
    expect(chats.chat.archivedAt).toBeTruthy();
    expect((await store.read()).values.ui?.pinnedChats).toEqual([{ botId: "bot-2", chatId: "x" }]);
    expect((await call("chats_list", { bot: "Inbox" })).data.chats).toEqual([]);
  });

  it("refuses chats that don't belong to a bot", async () => {
    const chats: Record<string, FakeChat> = { plain: { status: "running", labels: {}, reply: "secret" } };
    const { call, paseo } = await control(chats);
    for (const [name, args] of [
      ["chats_send", { chat: "plain", message: "hi" }],
      ["chats_read", { chat: "plain", last_reply: true }],
      ["chats_stop", { chat: "plain" }],
      ["chats_archive", { chat: "plain", confirm: true }],
    ] as const) {
      const refused = await call(name, args);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("isn't a bot's chat");
    }
    expect(paseo.sent).toEqual([]);
    expect(chats.plain?.archivedAt).toBeUndefined();
    expect((await call("chats_read", { chat: "missing" })).text).toContain("There's no chat with that id.");
  });
});
