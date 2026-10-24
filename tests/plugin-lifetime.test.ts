import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
import { ManagedAgentClaims } from "../server/managed-agent-claims";
import { Relay } from "../server/relay";
import { readHistoryText } from "../server/run-history-seal";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import { BOT_LABEL } from "../shared/bot";
import {
  chatsStartRpc,
  LocalChatStartResultSchema,
  LocalPreparedPlanSchema,
  runsPrepareRpc,
} from "../shared/local-start";
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
  if (failure === "missing") await rm(history);
  return { history, lock };
}

describe("native session ownership isolation", () => {
  useTempPaseoHome("paseo-bots-hook-isolation-");
  afterEach(async () => {
    await rm(pluginDataPath(), { recursive: true, force: true });
  });

  it.each(["legacy", "managed"] as const)(
    "creates a fresh %s agent when session opening precedes native persistence",
    async (executionMode) => {
      const bot = makeBot({ executionMode, cwd: "/work" });
      await new BotStore().update((values) => ({ ...values, bots: [bot] }));
      const daemon = await connectFakeDaemon({ creationLifecycle: true });
      const server = plugin(daemon);
      daemon.beforeSessionOpen(async (request) => {
        await server.open(request);
      });
      try {
        const input = {
          botId: bot.id,
          requestId: `before-native-persistence-${executionMode}`,
          prompt: "An inert transport creation",
        };
        const result = await vi.waitFor(
          async () => {
            const receipt = LocalChatStartResultSchema.parse(await server.call(chatsStartRpc.name, input));
            expect(receipt.status, receipt.message ?? undefined).toBe("created");
            return receipt;
          },
          { timeout: 10_000 },
        );
        const agentId = defined(result.agentId);
        expect((await daemon.api.agents.ref(agentId).refresh())?.agent.id).toBe(agentId);
        const snapshot = await new RunStore().read();
        const run = defined(
          Object.values(snapshot.routines)
            .flatMap((record) => record.runs)
            .find((candidate) => candidate.agentId === agentId),
        );
        expect(run).toMatchObject({
          agentCreationStatus: "created",
          taskOutcome: "unknown",
          sessionEpoch: executionMode === "managed" ? 1 : 0,
        });
        expect(Boolean(run.managed)).toBe(executionMode === "managed");
        expect(daemon.sent.filter((frame) => frame.type === "agent.create.request")).toHaveLength(1);
      } finally {
        await server.stop();
        await daemon.close();
      }
    },
    15_000,
  );
});

describe("retained native ownership isolation", () => {
  useTempPaseoHome("paseo-bots-retained-hook-isolation-");
  afterEach(async () => {
    await rm(pluginDataPath(), { recursive: true, force: true });
  });

  it.each(["lock", "future", "missing"] as const)(
    "keeps unrelated and legacy sessions independent of broken %s state",
    async (failure) => {
      const bot = makeBot({ executionMode: "managed", cwd: "/work" });
      await new BotStore().update((values) => ({ ...values, bots: [bot] }));
      const daemon = await connectFakeDaemon({ creationLifecycle: true });
      const initial = plugin(daemon);
      let managedId: string;
      try {
        const admitted = LocalPreparedPlanSchema.parse(
          await initial.call(runsPrepareRpc.name, {
            botId: bot.id,
            requestId: "retained-managed-ownership",
            prompt: "An inert deferred plan",
          }),
        );
        managedId = admitted.plannedAgentId;
      } finally {
        await initial.stop();
      }
      const { history, lock } = await breakHistory(failure);
      const before = await readFile(history, "utf8").catch(() => null);
      const server = plugin(daemon);
      daemon.beforeSessionOpen(async (request) => {
        await server.open(request);
      });
      vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const candidates: Record<string, string>[] = [
          {},
          { [BOT_LABEL]: "legacy-bot" },
          { [RUN_LABEL]: "not-owned" },
        ];
        for (const labels of candidates) {
          const agent = await daemon.api.workspaces.ref("ws-1").agents.create({
            agentId: newUuid(),
            config: { provider: "claude/claude-sonnet-5-5" },
            labels,
          });
          expect((await daemon.api.agents.ref(agent.id).refresh())?.agent.id).toBe(agent.id);
        }
        await expect(
          server.open({ ...opening(managedId), provider: bot.provider, reason: "resume" }),
        ).rejects.toThrow();
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
});

describe("unavailable native execution provenance", () => {
  useTempPaseoHome("paseo-bots-hook-provenance-");
  afterEach(async () => {
    await rm(pluginDataPath(), { recursive: true, force: true });
  });

  it("refuses native creation from an orphan managed claim without inventing an execution", async () => {
    const store = new RunStore();
    await store.initialize();
    const history = await realpath(store.path);
    const agentId = newUuid();
    await new ManagedAgentClaims(history).publish([agentId]);
    const before = await readFile(history, "utf8");
    const daemon = await connectFakeDaemon({ creationLifecycle: true });
    const server = plugin(daemon);
    daemon.beforeSessionOpen(async (request) => {
      await server.open(request);
    });
    try {
      const ordinary = await daemon.api.workspaces.ref("ws-1").agents.create({
        agentId: newUuid(),
        config: { provider: "claude/claude-sonnet-5-5" },
      });
      expect((await daemon.api.agents.ref(ordinary.id).refresh())?.agent.id).toBe(ordinary.id);
      await expect(
        daemon.api.workspaces.ref("ws-1").agents.create({
          agentId,
          config: { provider: "claude/claude-sonnet-5-5" },
        }),
      ).rejects.toThrow();
      expect(await daemon.api.agents.ref(agentId).refresh()).toBeNull();
      expect(await readFile(history, "utf8")).toBe(before);
    } finally {
      await server.stop();
      await daemon.close();
    }
  });

  it("passes history through without inspecting native identity or entering the broken gate", async () => {
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(join(pluginDataPath(), "coordinator.lock"), "foreign ownership");
    const history = join(pluginDataPath(), "routines.json");
    const before = '{"version":999,"routines":{}}';
    await writeFile(history, before);
    const daemon = await connectFakeDaemon({ creationLifecycle: true });
    const server = plugin(daemon);
    try {
      const request = { ...opening(newUuid()), purpose: "history" as const };
      const frames = [...daemon.sent];
      expect(await server.open(request)).toBe(request);
      expect(daemon.sent).toEqual(frames);
      expect(await readFile(history, "utf8")).toBe(before);
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
      const before = await readHistoryText(history);
      resumed.release();
      await rejected;
      expect(
        listening.mock.contexts.every((listener) => listener instanceof Server && !listener.listening),
      ).toBe(true);
      expect(await readHistoryText(history)).toBe(before);
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
