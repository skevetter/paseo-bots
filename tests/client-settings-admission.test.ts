import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useChatStartFeedback } from "../client/chat/LocalStartNotice";
import { type StartChat, useStartChat } from "../client/chat/useStartChat";
import type { BotHost } from "../client/data";
import type { BotStoreState } from "../client/useBotState";
import { type DraftState, useDrafts } from "../client/useBotsSurface";
import { type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { chatsStartRpc, type LocalChatStartResult } from "../shared/local-start";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon } from "./fake-daemon";
import { defined, makeBot } from "./helpers";

const rpc = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => defined(rpc.get(contract.name))(input),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({}));
vi.mock("react-native", () => ({ Platform: { OS: "web" } }));
vi.mock("../client/data", () => ({}));
vi.mock("../client/intent", () => ({}));
vi.mock("../client/keyboard", () => ({}));
vi.mock("../client/navigation", () => ({}));
vi.mock("../client/typography", () => ({}));
vi.mock("../client/ui/Menu", () => ({}));
vi.mock("../client/useBotState", () => ({}));
vi.mock("../client/native", () => ({}));
vi.mock("../client/panel/controls", () => ({}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  rpc.clear();
  vi.unstubAllGlobals();
});

async function settingsConsumer() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const daemon = await connectFakeDaemon({});
  cleanup.push(() => daemon.close());
  const bot = makeBot({ modeId: "full", cwd: "/work" });
  let saved: BotState = { bots: [bot], history: [], library: EMPTY_LIBRARY };
  const latest: { current: BotStoreState } = {
    current: {
      status: "ready",
      values: saved,
      revision: "one",
      saving: false,
      saveError: null,
      save: async () => true,
      reload: async () => {},
    },
  };
  const writes: { values: BotState; complete: (ok: boolean) => void }[] = [];
  const commit = (mutate: (values: BotState) => BotState) => {
    const values = mutate(saved);
    const gate = Promise.withResolvers<boolean>();
    writes.push({
      values,
      complete: (ok) => {
        if (ok) {
          saved = values;
          if (latest.current.status === "ready") latest.current = { ...latest.current, values };
        }
        gate.resolve(ok);
      },
    });
    return gate.promise;
  };
  const host: BotHost = { api: daemon.api, key: "origin", label: "Origin", isLocal: true, online: true };
  const admissions: BotState[] = [];
  rpc.set(chatsStartRpc.name, async (): Promise<LocalChatStartResult> => {
    admissions.push(saved);
    return {
      status: "created",
      mode: "legacy",
      agentId: newUuid(),
      plannedAgentId: null,
      planId: null,
      run: null,
      message: null,
    };
  });
  let current: { drafts: DraftState; start: StartChat } | null = null;
  function Consumer() {
    const drafts = useDrafts(latest, commit);
    const feedback = useChatStartFeedback();
    const selected = drafts.drafts[bot.id] ?? bot;
    const start = useStartChat({
      bot: selected,
      library: EMPTY_LIBRARY,
      policy: saved,
      host,
      feedback,
      onStarted: () => {},
      flush: drafts.flush,
      hasDraft: drafts.hasDraft,
    });
    current = { drafts, start };
    return null;
  }
  const renderer: { current: ReactTestRenderer | null } = { current: null };
  await act(() => {
    renderer.current = create(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Consumer)),
    );
  });
  const root = defined(renderer.current);
  cleanup.push(async () => {
    await act(() => root.unmount());
    for (const write of writes) write.complete(false);
  });
  return {
    writes,
    admissions,
    get current() {
      return defined(current);
    },
  };
}

it("keeps V2 live during an in-flight V1 flush and only admits after V2 is saved", async () => {
  const ui = await settingsConsumer();
  const message = { text: "Task", messageId: "intent", images: [], attachments: [] };
  await act(() => ui.current.drafts.patchBot("bot-1", { modeId: "default", executionMode: "managed" }));
  let autosave: Promise<boolean> = Promise.resolve(false);
  let start: Promise<void> = Promise.resolve();
  await act(() => {
    autosave = ui.current.drafts.flush();
    start = ui.current.start(message);
    void start.catch(() => {});
  });
  await act(() => ui.current.drafts.patchBot("bot-1", { model: "reviewed-model" }));
  expect(ui.admissions).toEqual([]);
  expect(ui.writes.map((write) => write.values.bots[0]?.model)).toEqual([null]);
  await act(async () => {
    defined(ui.writes[0]).complete(true);
    await autosave;
  });
  await expect(start).rejects.toThrow("settings");
  expect(ui.current.drafts.hasDraft("bot-1")).toBe(true);
  expect(ui.admissions).toEqual([]);
  await act(() => {
    start = ui.current.start(message);
  });
  await act(async () => {
    defined(ui.writes[1]).complete(true);
    await start;
  });
  expect(ui.current.drafts.hasDraft("bot-1")).toBe(false);
  expect(ui.admissions.map((values) => values.bots[0])).toEqual([
    expect.objectContaining({ modeId: "default", executionMode: "managed", model: "reviewed-model" }),
  ]);
});

it("retains the actionable draft and admits nothing after a failed save", async () => {
  const ui = await settingsConsumer();
  await act(() => ui.current.drafts.patchBot("bot-1", { modeId: "default" }));
  let start: Promise<void> = Promise.resolve();
  await act(() => {
    start = ui.current.start({ text: "Task", messageId: "intent", images: [], attachments: [] });
    void start.catch(() => {});
  });
  await act(async () => defined(ui.writes[0]).complete(false));
  await expect(start).rejects.toThrow("settings");
  expect(ui.current.drafts.drafts["bot-1"]?.modeId).toBe("default");
  expect(ui.admissions).toEqual([]);
});
