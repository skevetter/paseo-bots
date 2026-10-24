import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import contribute from "../index.server";
import { pluginDataPath } from "../server/bot-home";
import { routineStatusResponse } from "../server/routine-responses";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import { routineRunNowRpc, routineStatusRpc } from "../shared/rpc";
import { EXECUTION_STATUSES } from "../shared/runs";
import { defined, makeBot, makeRun, useTempPaseoHome } from "./helpers";

// The old client's schema is deliberately independent of the new server schemas.
const OldRun = z.object({
  id: z.string(),
  trigger: z.enum(["schedule", "manual", "webhook"]),
  scheduledFor: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "skipped-busy", "skipped-missed"]),
  agentId: z.string().nullable(),
  output: z.string().nullable(),
  error: z.string().nullable(),
});
const OldStatus = z.object({
  scheduler: z.boolean(),
  routines: z.record(z.string(), z.object({ lastRunAt: z.string().nullable(), runs: z.array(OldRun) })),
});

/** Register the real plugin handlers; validate and serialize their output as the SDK does. */
function rpcServer() {
  const calls = new Map<string, (input: unknown) => Promise<unknown>>();
  const context = { paseo: {} } as PluginHandlerContext;
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
  return {
    stop,
    call: (name: string, input: unknown = {}) => defined(calls.get(name))(input),
  };
}

describe("routine responses read by an old client", () => {
  useTempPaseoHome("paseo-bots-routine-rpc-");

  it("preserves old status fields on a real RPC response without believing historic succeeded", async () => {
    const path = join(pluginDataPath(), "routines.json");
    const fixture = await readFile(new URL("./fixtures/routines-v0.json", import.meta.url).pathname, "utf8");
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(path, fixture);
    const server = rpcServer();
    try {
      const response = await server.call("bots.routines.status");
      const old = OldStatus.parse(response);
      const runs = defined(old.routines["rt-runs"]).runs;
      expect(old.scheduler).toBe(true);
      expect(defined(old.routines["rt-runs"]).lastRunAt).toBe("2026-09-20T09:00:00.000Z");
      expect(runs[0]).toMatchObject({
        id: "run-aaaa1111",
        agentId: "chat-1",
        output: "All 12 invoices sent.",
        error: null,
        scheduledFor: "2026-09-18T09:00:00.000Z",
        startedAt: "2026-09-18T09:00:01.000Z",
        endedAt: "2026-09-18T09:04:00.000Z",
        trigger: "schedule",
      });
      const current = routineStatusRpc.output.parse(response);
      expect(defined(current.routines["rt-runs"]).runs[0]).toMatchObject({
        status: "succeeded",
        executionStatus: "completed",
        taskOutcome: "unknown",
        verification: null,
      });
      const store = new RunStore(path);
      const internal = defined((await store.read()).routines["rt-runs"]).runs[0];
      expect(internal).not.toHaveProperty("status");
      await store.update(() => {});
      expect(await readFile(`${path}.pre-run-store`, "utf8")).toBe(fixture);
      const saved = JSON.parse(await readFile(path, "utf8"));
      expect(saved.routines["rt-runs"].runs[0]).toMatchObject({
        executionStatus: "completed",
        taskOutcome: "unknown",
      });
      expect(saved.routines["rt-runs"].runs[0]).not.toHaveProperty("status");
      const reopened = routineStatusRpc.output.parse(await server.call("bots.routines.status"));
      expect(defined(reopened.routines["rt-runs"]).runs[0]?.taskOutcome).toBe("unknown");
    } finally {
      await server.stop();
    }
  });
});

describe("new execution statuses read by an old client", () => {
  useTempPaseoHome("paseo-bots-routine-rpc-states-");

  it("projects every execution status into the old enum while preserving the authoritative facts", async () => {
    const store = new RunStore();
    await store.update((routines) => {
      for (const executionStatus of EXECUTION_STATUSES)
        routines[executionStatus] = {
          lastRunAt: null,
          runs: [makeRun(executionStatus, { executionStatus })],
        };
    });
    const response = routineStatusResponse({ scheduler: true, routines: (await store.read()).routines });
    const old = OldStatus.parse(response);
    expect(EXECUTION_STATUSES.map((status) => defined(old.routines[status]).runs[0]?.status)).toEqual([
      "running",
      "running",
      "running",
      "running",
      "running",
      "running",
      "succeeded",
      "failed",
      "failed",
      "failed",
    ]);
    const current = routineStatusRpc.output.parse(response);
    expect(
      EXECUTION_STATUSES.map((status) => defined(current.routines[status]).runs[0]?.executionStatus),
    ).toEqual([...EXECUTION_STATUSES]);
    expect(
      EXECUTION_STATUSES.map((status) => defined(current.routines[status]).runs[0]?.taskOutcome),
    ).toEqual(EXECUTION_STATUSES.map(() => "unknown"));
  });
});

describe("run-now responses read by an old client", () => {
  useTempPaseoHome("paseo-bots-routine-rpc-run-now-");

  it("also preserves the run-now envelope and old run type", async () => {
    await new BotStore().update((values) => ({
      ...values,
      bots: [
        makeBot({
          hostId: "another-host",
          routines: [
            {
              id: "rt-away",
              name: "Away",
              prompt: "Go",
              enabled: true,
              schedule: { kind: "webhook" },
              resultsChatId: null,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      ],
    }));
    const server = rpcServer();
    try {
      const response = await server.call("bots.routines.run-now", { botId: "bot-1", routineId: "rt-away" });
      const old = z.object({ run: OldRun }).parse(response);
      expect(old.run.status).toBe("failed");
      expect(old.run.agentId).toBeNull();
      expect(old.run.error).toContain("another host");
      expect(routineRunNowRpc.output.parse(response).run).toMatchObject({
        executionStatus: "failed",
        taskOutcome: "no_change",
        status: "failed",
      });
      expect(defined((await new RunStore().read()).routines["rt-away"]).runs[0]).not.toHaveProperty("status");
    } finally {
      await server.stop();
    }
  });
});

describe("routine RPCs encountering a future run store", () => {
  useTempPaseoHome("paseo-bots-routine-rpc-future-");

  it("returns an error instead of a writable empty status response", async () => {
    const path = join(pluginDataPath(), "routines.json");
    const future = JSON.stringify({ version: 4, routines: {}, occurrences: ["not-ours-to-reset"] });
    await mkdir(pluginDataPath(), { recursive: true });
    await writeFile(path, future);
    const server = rpcServer();
    try {
      await expect(server.call("bots.routines.status")).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(future);
    } finally {
      await server.stop();
    }
  });
});
