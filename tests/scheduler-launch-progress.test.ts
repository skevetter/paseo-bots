import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { Relay } from "../server/relay";
import { RoutineScheduler } from "../server/scheduler";
import type { Routine } from "../shared/bot";
import { makePrepared } from "./coordinator-fixture";
import { fakeHost, makeBot } from "./helpers";

const running: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
  vi.useRealTimers();
});

function dueRoutine(id: string, deadlineSeconds?: number): Routine {
  return {
    id,
    name: id,
    prompt: "Observe only.",
    enabled: true,
    schedule: { kind: "once", at: new Date().toISOString() },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    resultsChatId: null,
    ...(deadlineSeconds === undefined ? {} : { runtime: { deadlineSeconds } }),
  };
}

function useClockHome(prefix: string) {
  const homes: string[] = [];
  const previous = process.env.PASEO_HOME;
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), prefix));
    homes.push(home);
    process.env.PASEO_HOME = home;
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00.000Z"));
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  });
}

describe("scheduler launch progress through the real clock tick", () => {
  useClockHome("paseo-bots-scheduler-launch-progress-");

  it.each([
    { executionMode: "managed", phase: "creation" },
    { executionMode: "legacy", phase: "creation" },
    { executionMode: "legacy", phase: "preparation" },
  ] as const)(
    "creates the second due bot before its deadline while $executionMode $phase hangs",
    async ({ executionMode, phase }) => {
      const host = fakeHost([
        makeBot({ id: "slow", provider: "slow-provider", executionMode, routines: [dueRoutine("rt-slow")] }),
        makeBot({
          id: "fast",
          provider: "fast-provider",
          executionMode: "managed",
          routines: [dueRoutine("rt-fast", 10)],
        }),
      ]);
      const held = Promise.withResolvers<void>();
      const firstStarted = Promise.withResolvers<void>();
      let heldStageEntered = false;
      let firstAcknowledged = false;
      const launches: { botId: string; at: number }[] = [];
      const relay = new Relay(host, []);
      const scheduler = new RoutineScheduler(host, relay, {
        now: () => Date.now(),
        launchTimeoutMs: 30_000,
        prepare: async (_host, _relay, bot, input) => {
          if (bot.id === "slow" && phase === "preparation") {
            heldStageEntered = true;
            firstStarted.resolve();
            await held.promise;
          }
          if (bot.id === "fast") await firstStarted.promise;
          return makePrepared({
            botId: bot.id,
            provider: bot.provider,
            agentId: input.agentId,
            idempotencyKey: input.idempotencyKey,
            prompt: input.prompt,
            labels: input.labels ?? {},
          });
        },
        launch: async (_host, _relay, prepared) => {
          launches.push({ botId: prepared.botId, at: Date.now() });
          if (prepared.botId === "slow") {
            if (phase === "creation") {
              heldStageEntered = true;
              firstStarted.resolve();
              await held.promise;
            }
            firstAcknowledged = true;
          }
          return prepared.agentId;
        },
        refresh: async (_relay, prepared) => prepared,
      });
      running.push(scheduler, relay);
      try {
        host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as never);
        await vi.waitFor(() => expect(heldStageEntered).toBe(true));
        vi.advanceTimersByTime(5_000);
        await vi.waitFor(() => expect(launches.some((launch) => launch.botId === "fast")).toBe(true), {
          timeout: 750,
        });
        expect(firstAcknowledged).toBe(false);
        expect(launches.find((launch) => launch.botId === "fast")?.at).toBeLessThan(
          Date.parse("2026-10-23T12:00:10.000Z"),
        );
      } finally {
        held.resolve();
      }
    },
  );
});

describe("legacy shutdown before and during creation", () => {
  useClockHome("paseo-bots-scheduler-launch-stop-");

  it.each(["preparation", "creation"] as const)(
    "stops during legacy %s without a fresh create or late metadata mutation",
    async (phase) => {
      const routine = { ...dueRoutine("rt-legacy"), schedule: { kind: "webhook" as const } };
      const host = fakeHost([makeBot({ id: "legacy", executionMode: "legacy", routines: [routine] })]);
      const held = Promise.withResolvers<void>();
      let entered = false;
      let released = false;
      const relay = new Relay(host, []);
      const launches: string[] = [];
      const scheduler = new RoutineScheduler(host, relay, {
        prepare: async (_host, _relay, bot, input) => {
          if (phase === "preparation") {
            entered = true;
            await held.promise;
            released = true;
          }
          return makePrepared({
            botId: bot.id,
            agentId: input.agentId,
            idempotencyKey: input.idempotencyKey,
          });
        },
        launch: async (_host, _relay, prepared) => {
          launches.push(prepared.agentId);
          if (phase === "creation") {
            entered = true;
            await held.promise;
            released = true;
          }
          return prepared.agentId;
        },
      });
      running.push(scheduler, relay);
      host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as never);
      const pending = scheduler.runNow("legacy", routine.id);
      let admissionError: unknown;
      void pending.catch((error: unknown) => {
        admissionError = error;
      });
      let stopped = false;
      let stop: Promise<void> | undefined;
      try {
        await vi.waitFor(() => {
          if (admissionError) throw admissionError;
          expect(entered).toBe(true);
        });
        stop = scheduler.stop().then(() => {
          stopped = true;
        });
        await vi.waitFor(() => expect(stopped).toBe(true));
        const { run } = await pending;
        expect(run.executionStatus).toBe(phase === "preparation" ? "canceled" : "starting");
        expect(run.taskOutcome).toBe(phase === "preparation" ? "no_change" : "unknown");
        const before = await readFile(join(pluginDataPath(), "routines.json"), "utf8");
        held.resolve();
        await vi.waitFor(() => expect(released).toBe(true));
        await setImmediate();
        await scheduler.finished(routine.id, run.agentId ?? "never-created", {
          outcome: { kind: "completed" },
          reply: "Late delivery.",
        });
        expect(launches).toHaveLength(phase === "preparation" ? 0 : 1);
        expect(await readFile(join(pluginDataPath(), "routines.json"), "utf8")).toBe(before);
      } finally {
        held.resolve();
        await pending.catch(() => {});
        await stop;
      }
    },
  );
});
