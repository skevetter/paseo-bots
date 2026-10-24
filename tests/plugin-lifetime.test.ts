import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { Server } from "node:net";
import { join } from "node:path";
import type {
  PluginHookContext,
  PluginServerContext,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { pluginDataPath } from "../server/bot-home";
import { Relay } from "../server/relay";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import { BOT_LABEL } from "../shared/bot";
import { runsPrepareRpc } from "../shared/local-start";
import { RUN_LABEL } from "../shared/managed-runs";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";
import { defined, makeBot, useTempPaseoHome } from "./helpers";

type SessionHook = (input: { request: PluginSessionOpenRequest }, context: PluginHookContext) => unknown;

function plugin(daemon: FakeDaemon) {
  let session: SessionHook | undefined;
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    handlers.set(contract.name, async (input) =>
      contract.output.parse(
        await handler(contract.input.parse(input), { paseo: daemon.api } as PluginHookContext),
      ),
    );
  };
  const dispose = contribute({
    handle,
    on: () => () => {},
    before: (name: string, handler: SessionHook) => {
      if (name === "agent.session_open") session = handler;
      return () => {};
    },
    registerSettings: () => ({
      read: async () => ({ status: "invalid" }),
      subscribe: () => () => {},
    }),
  } as unknown as PluginServerContext);
  let stopping: Promise<void> | undefined;
  return {
    open: (request: PluginSessionOpenRequest) =>
      defined(session)({ request }, { paseo: daemon.api, signal: new AbortController().signal }),
    call: (name: string, input: unknown) => defined(handlers.get(name))(input),
    stop: () => (stopping ??= dispose()),
  };
}

function opening(agentId: string): PluginSessionOpenRequest {
  return {
    agentId,
    workspaceId: "ws-1",
    provider: "omp",
    cwd: "/work",
    reason: "create",
    purpose: "interactive",
    env: { PRESERVE: "unchanged" },
  };
}

function barrier() {
  let release = () => {};
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

afterEach(() => vi.restoreAllMocks());

async function breakHistory(failure: "lock" | "future" | "missing") {
  await mkdir(pluginDataPath(), { recursive: true });
  const history = join(pluginDataPath(), "routines.json");
  const lock = join(pluginDataPath(), "coordinator.lock");
  if (failure === "lock") await writeFile(lock, "retained foreign ownership");
  if (failure === "future") await writeFile(history, '{"version":999,"routines":{}}');
  if (failure === "missing") {
    await rm(history, { force: true });
    await new RunStore(history).initialize();
    await rm(history);
  }
  return { history, lock };
}

describe("native session ownership isolation", () => {
  useTempPaseoHome("paseo-bots-hook-isolation-");

  it.each(["lock", "future", "missing"] as const)(
    "keeps unrelated and legacy sessions independent of broken %s state",
    async (failure) => {
      const { history, lock } = await breakHistory(failure);
      const before = await readFile(history, "utf8").catch(() => null);
      const daemon = await connectFakeDaemon({ creationLifecycle: true });
      const server = plugin(daemon);
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        for (const labels of [{}, { [BOT_LABEL]: "legacy-bot" }]) {
          const request = opening(newUuid());
          daemon.setAgent(request.agentId, { labels });
          expect(await server.open(request)).toBe(request);
        }
        const managed = opening(newUuid());
        daemon.setAgent(managed.agentId, { labels: { [RUN_LABEL]: "retained-run" } });
        await expect(server.open(managed)).rejects.toThrow();
        expect(await readFile(history, "utf8").catch(() => null)).toBe(before);
        if (failure === "lock") expect(await readFile(lock, "utf8")).toBe("retained foreign ownership");
      } finally {
        await server.stop().catch(() => {});
        await daemon.close();
        await rm(lock, { force: true });
        await rm(history, { force: true });
      }
    },
  );

  it("passes history through without inspecting native identity or entering the broken gate", async () => {
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(join(pluginDataPath(), "coordinator.lock"), "foreign ownership");
    const daemon = await connectFakeDaemon({ creationLifecycle: true });
    const server = plugin(daemon);
    try {
      const request = { ...opening(newUuid()), purpose: "history" as const };
      const frames = [...daemon.sent];
      expect(await server.open(request)).toBe(request);
      expect(daemon.sent).toEqual(frames);
    } finally {
      await server.stop().catch(() => {});
      await daemon.close();
    }
  });
});

describe("plugin preparation lifetime", () => {
  useTempPaseoHome("paseo-bots-preparation-unload-");

  it("does not reopen a listener or dispatch creation when preparation resumes after unload", async () => {
    const bot = makeBot({ executionMode: "managed", cwd: "/work" });
    await new BotStore().update((values) => ({ ...values, bots: [bot] }));
    const entered = barrier();
    const resumed = barrier();
    const permissions = Relay.prototype.preparePermissions;
    let relay: Relay | undefined;
    vi.spyOn(Relay.prototype, "preparePermissions").mockImplementationOnce(async function (
      this: Relay,
      candidate,
    ) {
      relay = this;
      entered.release();
      await resumed.reached;
      return permissions.call(this, candidate);
    });
    const listening = vi.spyOn(Server.prototype, "listen");
    const daemon = await connectFakeDaemon({ creationLifecycle: true });
    const server = plugin(daemon);
    const preparing = server.call(runsPrepareRpc.name, {
      botId: bot.id,
      requestId: "unload-during-permissions",
      prompt: "An inert preparation, never an execution",
    });
    const rejected = expect(preparing).rejects.toThrow();
    try {
      await entered.reached;
      await server.stop();
      const history = join(pluginDataPath(), "routines.json");
      const before = await readFile(history, "utf8");
      resumed.release();
      await rejected;
      expect(listening.mock.contexts.every((listener) => !listener.listening)).toBe(true);
      expect(await readFile(history, "utf8")).toBe(before);
      expect(daemon.sent.filter((frame) => frame.type === "agent.create.request")).toEqual([]);
    } finally {
      resumed.release();
      await preparing.catch(() => {});
      await server.stop().catch(() => {});
      await relay?.stop();
      await daemon.close();
    }
  });
});
