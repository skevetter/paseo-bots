import { join } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import { type RoutineActions, useRoutineActions } from "../client/panel/routines/useRoutineActions";
import { pluginDataPath } from "../server/bot-home";
import { Relay } from "../server/relay";
import { RunArtifacts } from "../server/run-artifacts";
import { RunStore } from "../server/run-store";
import { RoutineScheduler } from "../server/scheduler";
import { BOT_LABEL, type Routine } from "../shared/bot";
import type { PreparedBotChat } from "../shared/chat";
import { routineRunNowRpc } from "../shared/rpc";
import { makePrepared } from "./coordinator-fixture";
import { connectFakeDaemon } from "./fake-daemon";
import { defined, fakeHost, makeBot, useTempPaseoHome } from "./helpers";

const rpc = vi.hoisted(() => new Map<string, (input: unknown) => Promise<unknown>>());
vi.mock("@getpaseo/plugin/client", () => ({
  useRpc: (contract: { name: string }) => (input: unknown) => defined(rpc.get(contract.name))(input),
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  useToast: () => ({ show: () => {}, error: () => {} }),
  copyText: async () => {},
}));
vi.mock("../client/native", () => ({
  errorText: (error: unknown) => String(error),
  confirmDialog: async () => true,
}));

async function service() {
  const daemon = await connectFakeDaemon({ creationLifecycle: true, agentRequestReceipts: true });
  const routine: Routine = {
    id: "routine-1",
    name: "Review",
    prompt: "Review without external writes.",
    enabled: false,
    schedule: { kind: "interval", minutes: 60 },
    resultsChatId: null,
    createdAt: "2026-10-23T00:00:00.000Z",
  };
  const bot = makeBot({
    executionMode: "managed",
    provider: "omp",
    model: "frozen-model",
    modeId: "full",
    routines: [routine],
  });
  const host = fakeHost([bot]);
  const store = new RunStore(join(pluginDataPath(), "routines.json"));
  const relay = new Relay(host, []);
  const scheduler = new RoutineScheduler(host, relay, {
    store,
    refresh: async (_relay, prepared) => prepared,
    prepare: async (_host, _relay, target, input) => {
      const prepared = makePrepared({
        botId: target.id,
        agentId: defined(input.agentId),
        idempotencyKey: defined(input.idempotencyKey),
        labels: { [BOT_LABEL]: target.id, ...input.labels },
        placement: { path: "/work", projectRoot: null },
      });
      return {
        ...prepared,
        config: { ...prepared.config, modeId: target.modeId ?? undefined },
        metadata: {
          ...prepared.metadata,
          permissionEnvelope: { ...prepared.metadata.permissionEnvelope, modeId: target.modeId },
        },
      };
    },
  });
  const recovery = vi.spyOn(scheduler.coordinator, "recover");
  host.attach(daemon.api);
  await defined(recovery.mock.results[0]).value;
  recovery.mockRestore();
  rpc.set(routineRunNowRpc.name, async (input) => {
    const request = routineRunNowRpc.input.parse(input);
    return scheduler.runNow(request.botId, request.routineId, request.requestId);
  });
  return { daemon, scheduler, relay, store, bot, routine };
}

describe("routine settings admission", () => {
  useTempPaseoHome("paseo-routine-settings-admission-");

  it("does not durably admit or create a routine after failed settings persistence, then uses the saved approval mode", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const h = await service();
    let saved = false;
    let actions: RoutineActions | undefined;
    function Consumer() {
      actions = useRoutineActions({ bot: h.bot, onPatch: () => {}, flush: async () => saved });
      return null;
    }
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(() => {
        renderer = create(
          createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Consumer)),
        );
      });
      await act(() => defined(actions).run(h.routine, null));
      expect((await h.store.read()).routines).toEqual({});
      const creationFrames = () =>
        h.daemon.sent.filter((frame) =>
          ["agent.create.request", "create_agent_request"].includes(String(frame.type)),
        );
      expect(creationFrames()).toEqual([]);
      h.bot.modeId = "default";
      saved = true;
      await act(() => defined(actions).run(h.routine, null));
      const retained = defined((await h.store.read()).routines[h.routine.id]);
      const run = defined(retained.runs[0]);
      expect(run.agentCreationStatus).toBe("created");
      expect(run.taskOutcome).toBe("unknown");
      const frozen = await new RunArtifacts(pluginDataPath()).get<{ prepared: PreparedBotChat }>(
        defined(run.managed).artifact,
      );
      expect(frozen.prepared.config.modeId).toBe("default");
      expect(creationFrames()).toHaveLength(1);
    } finally {
      if (renderer) await act(() => renderer?.unmount());
      await h.scheduler.stop();
      await h.relay.close();
      await h.daemon.close();
      rpc.clear();
      vi.unstubAllGlobals();
    }
  });
});
