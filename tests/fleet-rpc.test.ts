import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it, vi } from "vitest";
import contribute from "../index.server";
import { BotStore } from "../server/state";
import { fleetApplyRpc, fleetListRpc, fleetPreviewRpc, fleetRevertRpc } from "../shared/fleet";
import { defined, makeBot, useTempPaseoHome } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

function rpcServer() {
  const calls = new Map<string, (input: unknown) => Promise<unknown>>();
  const mutations = vi.fn(() => {
    throw new Error("No active-session mutations allowed.");
  });
  const context = {
    paseo: {
      providers: { snapshot: async () => ({ entries: LIVE_PROVIDERS }) },
      agents: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false } }),
        ref: mutations,
        create: mutations,
      },
    },
  } as unknown as PluginHandlerContext;
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    calls.set(contract.name, async (input) => {
      const response = await handler(contract.input.parse(input), context);
      return JSON.parse(JSON.stringify(contract.output.parse(response)));
    });
  };
  const stop = contribute({
    handle,
    on: () => () => {},
    before: () => () => {},
    registerSettings: () => ({
      read: async () => ({ status: "invalid" }),
      subscribe: () => () => {},
    }),
  } as unknown as PluginServerContext);
  return { stop, mutations, call: (name: string, input: unknown) => defined(calls.get(name))(input) };
}

describe("registered fleet RPCs", () => {
  useTempPaseoHome("paseo-bots-fleet-rpc-");

  it("round-trips 100 exact targets, all receipt metadata, replay, and audited revert through real handlers", async () => {
    const store = new BotStore();
    const initial = await store.update((values) => ({
      ...values,
      bots: Array.from({ length: 100 }, (_, index) => makeBot({ id: `bot-${index}` })),
    }));
    const server = rpcServer();
    try {
      const listing = fleetListRpc.output.parse(await server.call(fleetListRpc.name, {}));
      const request = {
        operationId: "rpc-fleet-1",
        revision: listing.revision,
        botIds: listing.rows.map((row) => row.bot.id),
        patch: { model: "opus" },
        unset: [],
      };
      const preview = fleetPreviewRpc.output.parse(await server.call(fleetPreviewRpc.name, request));
      if (preview.status !== "previewed") throw new Error(preview.error);
      expect(preview.preview.activeChatsUnaffected).toBe(true);
      const result = fleetApplyRpc.output.parse(
        await server.call(fleetApplyRpc.name, { request, previewDigest: preview.preview.digest }),
      );
      if (result.status !== "applied") throw new Error(JSON.stringify(result));
      expect(result.receipt.originalRevision).toBe(initial.revision);
      expect(result.receipt.newRevision).toBe(result.revision);
      expect((await new BotStore().read()).values.bots.every((bot) => bot.model === "opus")).toBe(true);
      const replay = fleetApplyRpc.output.parse(
        await server.call(fleetApplyRpc.name, { request, previewDigest: preview.preview.digest }),
      );
      expect(replay).toEqual({ ...result, status: "replayed" });
      const reverted = fleetRevertRpc.output.parse(
        await server.call(fleetRevertRpc.name, {
          operationId: "rpc-revert-1",
          revision: result.revision,
          appliedOperationId: request.operationId,
        }),
      );
      expect(reverted.status).toBe("applied");
      expect((await new BotStore().read()).values.bots.every((bot) => bot.model === null)).toBe(true);
      expect(server.mutations).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("rejects malformed exact-target requests before mutation", async () => {
    const server = rpcServer();
    try {
      const before = await new BotStore().read();
      const request = {
        operationId: "rpc-invalid",
        revision: before.revision,
        botIds: ["bot-0", "bot-0"],
        patch: { model: null },
        unset: [],
      };
      await expect(server.call(fleetPreviewRpc.name, request)).rejects.toThrow("Select each bot only once");
      await expect(server.call(fleetApplyRpc.name, { request, previewDigest: "tampered" })).rejects.toThrow();
      expect(await new BotStore().read()).toEqual(before);
    } finally {
      await server.stop();
    }
  });
});
