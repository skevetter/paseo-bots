import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type ChatStartFeedback,
  ChatStartNotices,
  useChatStartFeedback,
} from "../client/chat/LocalStartNotice";
import { type StartChat, type StartChatOptions, useStartChat } from "../client/chat/useStartChat";
import type { BotHost } from "../client/data";
import { Button } from "../client/panel/controls";
import { EMPTY_LIBRARY } from "../shared/bot";
import { chatsStartRpc, type LocalChatStartResult, LocalChatStartResultSchema } from "../shared/local-start";
import { ensureBotHomeRpc, systemPromptRpc } from "../shared/rpc";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";
import { defined, makeBot } from "./helpers";

const rpc = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => {
    const call = rpc.get(contract.name);
    if (!call) throw new Error(`Unexpected RPC ${contract.name}`);
    return call(input);
  },
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View", ScrollView: "ScrollView" }));
vi.mock("../client/native", () => ({ errorText: (error: unknown) => String(error) }));
vi.mock("../client/panel/controls", () => ({ Button: "Button" }));
vi.mock("../client/typography", () => ({ ui: (value: number) => value }));
const message = { text: "Do the task", messageId: "request-1", images: [], attachments: [] };

const created = (): LocalChatStartResult => ({
  status: "created",
  mode: "legacy",
  agentId: newUuid(),
  plannedAgentId: null,
  planId: null,
  run: null,
  message: null,
});
const roots: ReactTestRenderer[] = [];
const daemons: FakeDaemon[] = [];
const colors = {
  surface0: "#000",
  surface1: "#111",
  surface2: "#222",
  border: "#333",
  foreground: "#fff",
  foregroundMuted: "#aaa",
  accent: "#00f",
  accentForeground: "#fff",
  statusSuccess: "#0f0",
  statusWarning: "#ff0",
  statusDanger: "#f00",
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  rpc.clear();
});
afterEach(async () => {
  for (const root of roots.splice(0)) await act(() => root.unmount());
  for (const daemon of daemons.splice(0)) await daemon.close();
  vi.unstubAllGlobals();
});

async function consumer(initialHost: BotHost, flush = async () => true, hasDraft = () => false) {
  const opened: string[] = [];
  let current: {
    start: StartChat;
    feedback: ChatStartFeedback;
  } | null = null;
  function Consumer({ host }: { host: BotHost }) {
    const feedback = useChatStartFeedback();
    const options: StartChatOptions = {
      bot: makeBot({ cwd: "/work", hostId: host.isLocal ? null : host.key }),
      host,
      library: EMPTY_LIBRARY,
      policy: {},
      onStarted: (id) => opened.push(id),
      feedback,
      flush,
      hasDraft,
    };
    current = { start: useStartChat(options), feedback };
    return createElement(ChatStartNotices, {
      colors,
      botId: options.bot.id,
      host,
      compact: false,
      feedback,
      onStarted: options.onStarted,
      flush,
      hasDraft,
    });
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = (host: BotHost) =>
    createElement(QueryClientProvider, { client: queryClient }, createElement(Consumer, { host }));
  const renderer: { current: ReactTestRenderer | null } = { current: null };
  await act(() => {
    renderer.current = create(element(initialHost));
  });
  const root = defined(renderer.current);
  roots.push(root);
  return {
    opened,
    root,
    get current() {
      return defined(current);
    },
    update: (host: BotHost) => act(() => root.update(element(host))),
  };
}

async function hosts() {
  const daemon = await connectFakeDaemon({ creationLifecycle: true });
  const localDaemon = await connectFakeDaemon({ creationLifecycle: true });
  daemons.push(daemon, localDaemon);
  const local: BotHost = {
    api: localDaemon.api,
    key: "host-a",
    label: "Host A",
    isLocal: true,
    online: true,
  };
  return {
    daemon,
    localDaemon,
    local,
    remote: { ...local, api: daemon.api, key: "host-b", label: "Host B", isLocal: false },
  };
}

it("waits for settings and refuses a newer remaining draft instead of launching saved wider settings", async () => {
  const { local } = await hosts();
  const saving = Promise.withResolvers<boolean>();
  let pending = true;
  const launches = vi.fn(async () => created());
  rpc.set(chatsStartRpc.name, launches);
  const ui = await consumer(
    local,
    () => saving.promise,
    () => pending,
  );
  let started: Promise<void> = Promise.resolve();
  await act(() => {
    started = ui.current.start(message);
    void started.catch(() => {});
  });
  expect(launches).not.toHaveBeenCalled();
  await act(async () => saving.resolve(true));
  await expect(started).rejects.toThrow("settings");
  expect(launches).not.toHaveBeenCalled();
  pending = false;
  await act(() => ui.current.start(message));
  expect(launches).toHaveBeenCalledTimes(1);
});

it("retains created local origin evidence without navigating after a same-bot host change", async () => {
  const { local, remote } = await hosts();
  const response = Promise.withResolvers<LocalChatStartResult>();
  rpc.set(chatsStartRpc.name, () => response.promise);
  const ui = await consumer(local);
  let started: Promise<void> = Promise.resolve();
  await act(() => {
    started = ui.current.start(message);
  });
  await ui.update(remote);
  const result = created();
  await act(async () => {
    response.resolve(result);
    await started;
  });
  expect(ui.opened).toEqual([]);
  expect(ui.current.feedback.pending).toMatchObject([
    { origin: { key: local.key }, input: { requestId: message.messageId }, result },
  ]);
});

it("refuses new admission when origin changes during settings save", async () => {
  const { local, remote } = await hosts();
  const saving = Promise.withResolvers<boolean>();
  const launches = vi.fn(async () => created());
  rpc.set(chatsStartRpc.name, launches);
  const ui = await consumer(local, () => saving.promise);
  let started: Promise<void> = Promise.resolve();
  await act(() => {
    started = ui.current.start(message);
    void started.catch(() => {});
  });
  await ui.update(remote);
  await act(async () => saving.resolve(true));
  await expect(started).rejects.toThrow("host");
  expect(launches).not.toHaveBeenCalled();
});

it("does not convert a failed settings save into admission even when no draft remains", async () => {
  const { local } = await hosts();
  const launches = vi.fn(async () => created());
  rpc.set(chatsStartRpc.name, launches);
  const ui = await consumer(local, async () => false);
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("settings");
  });
  expect(launches).not.toHaveBeenCalled();
});

it("rechecks unknown transport failures but does not strand an acknowledged request behind later edits", async () => {
  const { local } = await hosts();
  let saveOk = true;
  let pending = false;
  let calls = 0;
  const planId = `run-${newUuid()}`;
  const accepted = LocalChatStartResultSchema.parse({
    status: "pending",
    mode: "managed",
    agentId: null,
    plannedAgentId: newUuid(),
    planId,
    run: { id: planId, executionStatus: "queued", taskOutcome: "unknown", purpose: "task" },
    message: null,
  });
  rpc.set(chatsStartRpc.name, async () => {
    calls++;
    if (calls === 1) throw new Error("Transport closed");
    return accepted;
  });
  const ui = await consumer(
    local,
    async () => saveOk,
    () => pending,
  );
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("Transport");
  });
  saveOk = false;
  pending = true;
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("settings");
  });
  expect(calls).toBe(1);
  saveOk = true;
  pending = false;
  await act(() => ui.current.start(message));
  saveOk = false;
  pending = true;
  await act(() => ui.current.start(message));
  expect(calls).toBe(3);
  await act(async () => {
    await expect(ui.current.start({ ...message, messageId: "new-intent" })).rejects.toThrow("settings");
  });
  expect(calls).toBe(3);
});

it("retains remote created evidence after host switching without invoking local admission", async () => {
  const { daemon, localDaemon, local, remote } = await hosts();
  daemon.hold();
  rpc.set(ensureBotHomeRpc.name, async () => ({ path: "/work", root: "/work" }));
  rpc.set(systemPromptRpc.name, async () => ({ systemPrompt: "Remote task" }));
  const ui = await consumer(remote);
  let started: Promise<void> = Promise.resolve();
  await act(() => {
    started = ui.current.start(message);
  });
  await vi.waitFor(() =>
    expect(daemon.sent.some((frame) => frame.type === "agent.create.request")).toBe(true),
  );
  await ui.update(local);
  await act(async () => {
    daemon.release();
    await started;
  });
  expect(ui.opened).toEqual([]);
  const createFrame = defined(daemon.sent.find((frame) => frame.type === "agent.create.request"));
  expect(localDaemon.sent.some((frame) => frame.type === "agent.create.request")).toBe(false);
  expect(ui.current.feedback.created).toMatchObject([
    {
      origin: { key: remote.key },
      botId: "bot-1",
      requestId: message.messageId,
      agentId: createFrame.agentId,
    },
  ]);
  const button = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Open created chat"),
  );
  expect(button.props.disabled).toBe(true);
  await act(() => button.props.onPress());
  expect(ui.opened).toEqual([]);
  await ui.update(remote);
  const available = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Open created chat"),
  );
  expect(available.props.disabled).toBe(false);
  await act(() => available.props.onPress());
  expect(ui.opened).toEqual([createFrame.agentId]);
  expect(ui.current.feedback.created).toEqual([]);
});

it("does not admit an unacknowledged notice check after a failed settings flush", async () => {
  const { local } = await hosts();
  let saveOk = true;
  let calls = 0;
  rpc.set(chatsStartRpc.name, async () => {
    calls++;
    throw new Error("Response lost");
  });
  const ui = await consumer(local, async () => saveOk);
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("Response lost");
  });
  saveOk = false;
  const check = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Check existing request"),
  );
  await act(() => check.props.onPress());
  expect(calls).toBe(1);
  expect(ui.current.feedback.pending).toMatchObject([
    {
      origin: { key: local.key },
      input: { requestId: message.messageId },
      result: null,
    },
  ]);
});

it("keeps an in-flight notice check bound to its origin after a local to remote switch", async () => {
  const { local, remote } = await hosts();
  const planId = `run-${newUuid()}`;
  const response = Promise.withResolvers<LocalChatStartResult>();
  const result = created();
  const ui = await consumer(local);
  rpc.set(chatsStartRpc.name, async () => ({
    status: "pending",
    mode: "managed",
    agentId: null,
    plannedAgentId: result.agentId,
    planId,
    run: { id: planId, executionStatus: "queued", taskOutcome: "unknown", purpose: "task" },
    message: null,
  }));
  await act(() => ui.current.start(message));
  rpc.set(chatsStartRpc.name, () => response.promise);
  const check = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Check existing request"),
  );
  await act(() => check.props.onPress());
  await ui.update(remote);
  await act(async () => {
    response.resolve(result);
    await response.promise;
  });
  expect(ui.opened).toEqual([]);
  expect(ui.current.feedback.pending).toMatchObject([{ origin: { key: local.key }, result }]);
  const open = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Open created chat"),
  );
  expect(open.props.disabled).toBe(true);
  await act(() => open.props.onPress());
  expect(ui.opened).toEqual([]);
  await ui.update(local);
  const recovered = defined(
    ui.root.root.findAllByType(Button).find((node) => node.props.label === "Open created chat"),
  );
  await act(() => recovered.props.onPress());
  expect(ui.opened).toEqual([result.agentId]);
});

it("replays an already-admitted canceled plan without requiring later unsaved settings", async () => {
  const { local } = await hosts();
  let saved = true;
  const planId = `run-${newUuid()}`;
  const response = LocalChatStartResultSchema.parse({
    status: "not_created",
    mode: "managed",
    agentId: null,
    plannedAgentId: newUuid(),
    planId,
    run: { id: planId, executionStatus: "canceled", taskOutcome: "unknown", purpose: "task" },
    message: "Canceled before launch",
  });
  const calls = vi.fn(async () => response);
  rpc.set(chatsStartRpc.name, calls);
  const ui = await consumer(
    local,
    async () => saved,
    () => !saved,
  );
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("Canceled before launch");
  });
  saved = false;
  await act(async () => {
    await expect(ui.current.start(message)).rejects.toThrow("Canceled before launch");
  });
  expect(calls).toHaveBeenCalledTimes(2);
});
