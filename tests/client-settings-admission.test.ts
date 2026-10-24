import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vitest";
import { useChatStartFeedback } from "../client/chat/LocalStartNotice";
import { type StartChat, useStartChat } from "../client/chat/useStartChat";
import type { BotHost } from "../client/data";
import { type DraftState, useBotDrafts } from "../client/useBotDrafts";
import type { BotStoreState, CommitBotState } from "../client/useBotState";
import { type BotState, EMPTY_LIBRARY } from "../shared/bot";
import { chatsStartRpc, type LocalChatStartResult } from "../shared/local-start";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon } from "./fake-daemon";
import { defined, makeBot } from "./helpers";

const rpc = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => defined(rpc.get(contract.name))(input),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ useToast: () => ({ error: () => {} }) }));
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mountConsumer(consumer: () => null): Promise<ReactTestRenderer> {
  const renderer: { current: ReactTestRenderer | null } = { current: null };
  await act(() => {
    renderer.current = create(
      createElement(QueryClientProvider, { client: new QueryClient() }, createElement(consumer)),
    );
  });
  return defined(renderer.current);
}

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
  const writes: {
    values: BotState;
    complete: (ok: boolean, remote?: (values: BotState) => BotState) => void;
  }[] = [];
  let revisions = 0;
  const commit: CommitBotState = (mutate, onSaved) => {
    const values = mutate(saved);
    const gate = Promise.withResolvers<boolean>();
    writes.push({
      values,
      complete: (ok, remote) => {
        if (ok) {
          const stored = remote ? remote(values) : values;
          saved = stored;
          revisions += 1;
          const revision = `rev-${revisions}`;
          latest.current = { ...latest.current, status: "ready", values: stored, revision };
          onSaved?.({ revision, values: stored });
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
    const drafts = useBotDrafts(latest, commit);
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
  const root = await mountConsumer(Consumer);
  let unmounted = false;
  const unmount = async () => {
    if (unmounted) return;
    unmounted = true;
    await act(() => root.unmount());
  };
  cleanup.push(async () => {
    await unmount();
    for (const write of writes) write.complete(false);
  });
  return {
    writes,
    admissions,
    unmount,
    get saved() {
      return saved;
    },
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

async function runAutosaveTimers(): Promise<void> {
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
}

it.each([true, false])("does not lose a newer autosave after an in-flight save resolves %s", async (ok) => {
  const ui = await settingsConsumer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(() => ui.current.drafts.patchBot("bot-1", { title: "First edit" }));
  await runAutosaveTimers();
  expect(ui.writes).toHaveLength(1);
  await act(() => ui.current.drafts.patchBot("bot-1", { modeId: "default", executionMode: "managed" }));
  await runAutosaveTimers();
  expect(ui.writes).toHaveLength(1);
  await act(() => defined(ui.writes[0]).complete(ok));
  await runAutosaveTimers();
  if (ok) {
    expect(ui.writes).toHaveLength(2);
    await act(() => defined(ui.writes[1]).complete(true));
    expect(ui.saved.bots[0]).toMatchObject({
      title: "First edit",
      modeId: "default",
      executionMode: "managed",
    });
    expect(ui.current.drafts.hasDraft("bot-1")).toBe(false);
  } else {
    expect(ui.writes).toHaveLength(1);
    expect(ui.saved.bots[0]?.modeId).toBe("full");
    expect(ui.current.drafts.hasDraft("bot-1")).toBe(true);
  }
});

it("drains the requested unmount flush after V1 without leaving an autosave timer", async () => {
  const ui = await settingsConsumer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(() => ui.current.drafts.patchBot("bot-1", { title: "First edit" }));
  await runAutosaveTimers();
  await act(() => ui.current.drafts.patchBot("bot-1", { modeId: "default" }));
  await runAutosaveTimers();
  await ui.unmount();
  await act(() => defined(ui.writes[0]).complete(true));
  expect(ui.writes).toHaveLength(2);
  await act(() => defined(ui.writes[1]).complete(true));
  expect(ui.saved.bots[0]).toMatchObject({ title: "First edit", modeId: "default" });
  await runAutosaveTimers();
  expect(ui.writes).toHaveLength(2);
});

it("publishes V2's conflict from V1's ACK and never auto-retries it", async () => {
  const ui = await settingsConsumer();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  await act(() => ui.current.drafts.patchBot("bot-1", { modeId: "default" }));
  let autosave: Promise<boolean> = Promise.resolve(false);
  await act(() => {
    autosave = ui.current.drafts.flush();
  });
  await act(() => ui.current.drafts.patchBot("bot-1", { model: "reviewed-model" }));
  await act(async () => {
    defined(ui.writes[0]).complete(true, (values) => ({
      ...values,
      bots: values.bots.map((bot) => ({ ...bot, model: "remote-model" })),
    }));
    await autosave;
  });
  expect(await autosave).toBe(true);
  expect(ui.current.drafts.draftConflicts["bot-1"]).toMatchObject({
    kind: "changed",
    fields: expect.arrayContaining(["model"]),
  });
  expect(ui.current.drafts.drafts["bot-1"]?.model).toBe("reviewed-model");
  expect(ui.current.drafts.hasDraft("bot-1")).toBe(true);
  await runAutosaveTimers();
  expect(ui.writes).toHaveLength(1);
});
