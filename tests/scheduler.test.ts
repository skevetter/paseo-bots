import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { writeAtomic } from "../server/files";
import { BotsHost } from "../server/host";
import { Relay } from "../server/relay";
import type { CoordinatorOptions } from "../server/run-coordinator";
import { RoutineScheduler, runPrompt } from "../server/scheduler";
import { type Bot, EMPTY_LIBRARY, type Routine } from "../shared/bot";
import { type ChatApi, type PreparedBotChat, prepareBotChat } from "../shared/chat";
import { PolicySchema } from "../shared/policies";
import { scheduleFrom, upcomingRuns } from "../shared/routines";
import { makePrepared } from "./coordinator-fixture";
import { defined, fakeHost, makeBot as makeBotFixture, makeRun } from "./helpers";
import { LIVE_PROVIDERS } from "./provider-modes";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);
const makeBot = (patch: Partial<Bot> = {}) => makeBotFixture({ executionMode: "managed", ...patch });

function routine(patch: Partial<Routine> = {}): Routine {
  return {
    id: "rt-1",
    name: "Inbox check",
    prompt: "Check the inbox.",
    enabled: true,
    schedule: { kind: "cron", expression: "0 9 * * 1-5" },
    resultsChatId: null,
    createdAt: local(1, 0).toISOString(),
    ...patch,
  };
}

type Launch = (prepared: PreparedBotChat) => Promise<string>;
const launchAssigned: Launch = async (prepared) => prepared.agentId;
const concurrentCapacity = { global: 4, perProvider: 4, perBot: 4 };
interface Facts {
  executionStatus: string;
  taskOutcome: string;
  skipped: string | null;
}
interface Card {
  agentId: string;
  item: { id: string; kind: string; data: Facts & { output: string | null; error: string | null } };
}

/** What a run or card says happened and whether the task worked, in one comparable string. */
const facts = (run: Facts) =>
  `${run.executionStatus}/${run.taskOutcome}${run.skipped ? `/skipped-${run.skipped}` : ""}`;

/** Cards wait for `posting.until`; cards posted to `brokenChat` throw, like a results chat that's gone. */
function fakePaseo(brokenChat?: string) {
  const appended: Card[] = [];
  const status = new Map<string, string>();
  const prepared = new Map<string, PreparedBotChat>();
  const unreachable = new Set<string>();
  const posting = { until: Promise.resolve() };
  const api = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => {
          if (unreachable.has(agentId)) throw new Error("Paseo didn't answer.");
          const frozen = prepared.get(agentId);
          if (!frozen) return null;
          return {
            agent: {
              id: agentId,
              labels: frozen.labels,
              status: status.get(agentId) ?? "idle",
              archivedAt: null,
              pendingPermissions: [],
            },
          };
        },
        timeline: {
          refetch: async () => ({
            entries: [
              {
                seqEnd: 1,
                item: {
                  type: "user_message",
                  clientMessageId: prepared.get(agentId)?.clientMessageId,
                  text: prepared.get(agentId)?.prompt,
                },
              },
            ],
            endCursor: { epoch: "test-epoch", seq: 1 },
            error: null,
            gap: false,
            staleCursor: false,
            hasNewer: false,
          }),
          append: async (item: never) => {
            await posting.until;
            if (agentId === brokenChat) throw new Error("That chat is gone.");
            appended.push({ agentId, item });
          },
        },
      }),
    },
  } as never;
  return { api, appended, status, unreachable, posting, prepared };
}

/** Every scheduler and relay a test makes; each test waits for them to stop before the next one starts. */
const running: { stop(): Promise<void> }[] = [];
const observedEpochs = new Map<string, number>();

function track(host: BotsHost, launch: Launch, options: CoordinatorOptions = {}) {
  const relay = new Relay(host, []);
  const scheduler = new RoutineScheduler(host, relay, {
    prepare: async (_host, _relay, bot, input) =>
      makePrepared({
        agentId: input.agentId,
        idempotencyKey: input.idempotencyKey,
        prompt: input.prompt,
        title: input.title,
        labels: input.labels ?? {},
        botId: bot.id,
        provider: bot.provider,
        purpose: input.purpose ?? "task",
      }),
    launch: async (_host, _relay, prepared) => {
      if (prepared.labels["paseo-bots.run"]) {
        const opening = await scheduler.coordinator.sessionOpened({
          agentId: prepared.agentId,
          workspaceId: null,
          provider: prepared.provider,
          cwd: prepared.placement.path,
          reason: "create",
          purpose: "interactive",
        });
        if (opening) observedEpochs.set(prepared.agentId, opening.sessionEpoch);
      }
      const agentId = await launch(prepared);
      if (observedEpochs.has(agentId)) await scheduler.coordinator.sessionActive(agentId);
      return agentId;
    },
    refresh: async (_relay, prepared) => prepared,
    ...options,
  });
  running.push(scheduler, relay);
  return { scheduler, relay };
}

async function startScheduler(
  bots: Bot[],
  launch: Launch = launchAssigned,
  brokenChat?: string,
  options: CoordinatorOptions = {},
) {
  const host = fakeHost(bots);
  const paseo = fakePaseo(brokenChat);
  const started = track(
    host,
    async (prepared) => {
      paseo.prepared.set(prepared.agentId, prepared);
      return launch(prepared);
    },
    options,
  );
  host.attach(paseo.api);
  return { ...started, host, ...paseo };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function writeState(name: string, text: string): Promise<void> {
  return writeAtomic(join(pluginDataPath(), name), text);
}

async function setAside(name: string): Promise<string[]> {
  const files = (await readdir(pluginDataPath())).filter((file) => file.startsWith(`${name}.corrupt-`));
  return Promise.all(files.map((file) => readFile(join(pluginDataPath(), file), "utf8")));
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((item) => item.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  observedEpochs.clear();
});

function useSchedulerHome(prefix: string) {
  const homes: string[] = [];
  const previous = process.env.PASEO_HOME;
  beforeEach(async () => {
    const home = await mkdtemp(join(tmpdir(), prefix));
    homes.push(home);
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previous;
    await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })));
  });
}

describe("routine schedules from chat", () => {
  it("reads each schedule type and explains what's wrong", async () => {
    const now = local(27, 12);
    expect(scheduleFrom({ type: "daily", time: "08:30", weekdays: [5, 1, 1] }, now)).toEqual({
      kind: "daily",
      time: "08:30",
      weekdays: [1, 5],
    });
    expect(scheduleFrom({ type: "cron", expression: " 0 9 * * 1-5 " }, now)).toEqual({
      kind: "cron",
      expression: "0 9 * * 1-5",
    });
    expect(scheduleFrom({ type: "once", at: "2026-09-28 09:00" }, now)).toEqual({
      kind: "once",
      at: local(28, 9).toISOString(),
    });
    expect(scheduleFrom({ type: "interval", every_minutes: 30 }, now)).toEqual({
      kind: "interval",
      minutes: 30,
    });
    expect(scheduleFrom({ type: "webhook" }, now)).toEqual({ kind: "webhook" });
    expect(() => scheduleFrom({ type: "once", at: "2026-09-01 09:00" }, now)).toThrow("already passed");
    expect(() => scheduleFrom({ type: "daily", time: "25:00" }, now)).toThrow('"HH:MM"');
    expect(() => scheduleFrom({ type: "cron", expression: "0 9 * *" }, now)).toThrow("5 fields");
    expect(() => scheduleFrom({ type: "interval" }, now)).toThrow("every_minutes");
  });

  it("lists the next runs", () => {
    // 2026-09-25 is a Friday.
    const now = local(25, 12);
    expect(upcomingRuns({ kind: "cron", expression: "0 9 * * 1-5" }, now, now, 3)).toEqual([
      local(28, 9),
      local(29, 9),
      local(30, 9),
    ]);
    expect(
      upcomingRuns({ kind: "daily", time: "18:00", weekdays: [0, 1, 2, 3, 4, 5, 6] }, now, now, 2),
    ).toEqual([local(25, 18), local(26, 18)]);
    expect(upcomingRuns({ kind: "interval", minutes: 60 }, local(25, 11, 30), now, 2)).toEqual([
      local(25, 12, 30),
      local(25, 13, 30),
    ]);
    expect(upcomingRuns({ kind: "once", at: local(26, 9).toISOString() }, now, now, 3)).toEqual([
      local(26, 9),
    ]);
    expect(upcomingRuns({ kind: "webhook" }, now, now, 3)).toEqual([]);
  });

  it("hands a webhook's body to the bot as marked data", async () => {
    const prompt = runPrompt(routine(), {
      body: '{"order": 42}',
      contentType: "application/json",
      receivedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(prompt).toContain(
      'Check the inbox.\n\n[UNTRUSTED WEBHOOK EVENT DATA]\nReceived: 2026-09-27T10:00:00.000Z\nContent type: application/json\n\n{"order": 42}\n[END WEBHOOK EVENT DATA]',
    );
    expect(runPrompt(routine())).toBe("Check the inbox.");
  });
});

describe("the routine scheduler", () => {
  useSchedulerHome("paseo-bots-scheduler-");

  it("records runs, posts cards to the results chat, and finishes them when the chat's turn ends", async () => {
    const hook = routine({
      id: "rt-hook",
      name: "Orders",
      schedule: { kind: "webhook" },
      resultsChatId: "results-chat",
    });
    const launched: PreparedBotChat[] = [];
    // Created now, so the first tick has no missed run to record.
    const { scheduler, appended } = await startScheduler(
      [makeBot({ id: "bot-r", routines: [routine({ createdAt: new Date().toISOString() }), hook] })],
      async (prepared) => {
        launched.push(prepared);
        return prepared.agentId;
      },
      undefined,
      { capacity: concurrentCapacity },
    );
    const manual = await scheduler.runNow("bot-r", "rt-1");
    expect(manual.run).toMatchObject({
      trigger: "manual",
      executionStatus: "running",
      taskOutcome: "unknown",
      agentId: launched[0]?.agentId,
    });
    // No results chat: nothing is posted.
    expect(appended).toHaveLength(0);

    // While that run's chat is working, the next run is skipped.
    expect(manual.run.agentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(facts((await scheduler.runNow("bot-r", "rt-1")).run)).toBe("canceled/unknown/skipped-busy");

    const { url } = await scheduler.webhookUrl("rt-hook");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\/rt-hook\/[a-f0-9]{48}$/);
    expect((await fetch(url)).status).toBe(405);
    expect((await fetch(url.replace(/.{8}$/, "00000000"), { method: "POST" })).status).toBe(404);
    const call = await fetch(url, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "order 42 shipped",
    });
    expect(call.status).toBe(202);
    const hookChat = defined(launched[1], "webhook launch");
    expect(await call.json()).toEqual({ status: "running", chat: hookChat.agentId });
    expect(hookChat.prompt).toContain("order 42 shipped");
    expect(appended.at(-1)).toMatchObject({
      agentId: "results-chat",
      item: {
        kind: "routine-run",
        data: { executionStatus: "running", taskOutcome: "unknown", output: null },
      },
    });

    // The run's turn ends: it's recorded and its card updated in place (same id).
    await scheduler.finished("rt-hook", hookChat.agentId, {
      outcome: { kind: "completed" },
      reply: "Shipped order 42 to Acme.",
      turnId: "turn-9",
      sessionEpoch: observedEpochs.get(hookChat.agentId),
    });
    const last = defined(appended.at(-1), "updated card");
    expect(last.item.id).toBe(defined(appended.at(-2), "posted card").item.id);
    // The turn completed. Nothing verified the task, so the outcome stays unknown.
    expect(last.item.data).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      output: "Shipped order 42 to Acme.",
    });
    const { routines } = await scheduler.status();
    expect(routines["rt-hook"]?.runs.map((run) => [run.trigger, facts(run), run.providerTurnId])).toEqual([
      ["webhook", "completed/unknown", "turn-9"],
    ]);
    expect(routines["rt-1"]?.runs.map(facts)).toEqual(["running/unknown", "canceled/unknown/skipped-busy"]);

    // A rotated URL retires the old one.
    const { url: fresh } = await scheduler.webhookUrl("rt-hook", true);
    expect(fresh).not.toBe(url);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  });
});

describe("routine runs", () => {
  useSchedulerHome("paseo-bots-scheduler-runs-");

  it("posts a card for a run it skipped because it was missed by too long", async () => {
    const missed = routine({
      id: "rt-missed",
      schedule: { kind: "once", at: hoursAgo(13) },
      resultsChatId: "digest-chat",
      createdAt: hoursAgo(14),
    });
    const { scheduler, appended } = await startScheduler(
      [makeBot({ id: "bot-m", routines: [missed] })],
      launchAssigned,
    );
    await vi.waitFor(() =>
      expect(appended.map((card) => [card.agentId, facts(card.item.data)])).toEqual([
        ["digest-chat", "canceled/unknown/skipped-missed"],
      ]),
    );
    const { routines } = await scheduler.status();
    expect(routines["rt-missed"]?.runs.map(facts)).toEqual(["canceled/unknown/skipped-missed"]);
  });

  it("keeps running the other routines when one of them fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const due = { schedule: { kind: "interval", minutes: 30 } as const, createdAt: hoursAgo(1) };
    const launched: string[] = [];
    const { scheduler } = await startScheduler(
      [
        makeBot({
          id: "bot-t",
          routines: [
            routine({ ...due, id: "rt-broken", name: "Broken", schedule: null as never }),
            routine({ id: "rt-after", name: "After", ...due }),
          ],
        }),
      ],
      async (prepared) => {
        launched.push(prepared.agentId);
        return prepared.agentId;
      },
    );
    await vi.waitFor(async () =>
      expect((await scheduler.status()).routines["rt-after"]?.runs.map((run) => run.agentId)).toEqual([
        defined(launched[0], "healthy routine agent"),
      ]),
    );
  });

  it("reports a run as started when its results chat can't take the card", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const lost = routine({ id: "rt-lost", resultsChatId: "gone-chat", createdAt: new Date().toISOString() });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-l", routines: [lost] })],
      launchAssigned,
      "gone-chat",
    );
    const { run } = await scheduler.runNow("bot-l", "rt-lost");
    expect(run).toMatchObject({
      executionStatus: "running",
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });
});

describe("routine chats that take a while to start", () => {
  useSchedulerHome("paseo-bots-scheduler-starts-");

  it("records other runs while a routine's chat is still starting, and skips it while it starts", async () => {
    let started: () => void = () => {};
    const slow = new Promise<void>((resolve) => {
      started = resolve;
    });
    const launched: PreparedBotChat[] = [];
    const fresh = { createdAt: new Date().toISOString() };
    const { scheduler } = await startScheduler(
      [
        makeBot({
          id: "bot-q",
          routines: [
            routine({ ...fresh, id: "rt-slow", name: "Slow" }),
            routine({ ...fresh, id: "rt-quick", name: "Quick" }),
          ],
        }),
      ],
      async (prepared) => {
        launched.push(prepared);
        if (prepared.title === "Slow") await slow;
        return prepared.agentId;
      },
      undefined,
      { capacity: concurrentCapacity },
    );
    const slowRun = scheduler.runNow("bot-q", "rt-slow");
    await vi.waitFor(() => expect(launched.map((chat) => chat.title)).toContain("Slow"));
    const slowChat = defined(
      launched.find((chat) => chat.title === "Slow"),
      "slow agent",
    );
    const quickRun = (await scheduler.runNow("bot-q", "rt-quick")).run;
    expect(quickRun.executionStatus).toBe("running");
    expect(quickRun.agentId).not.toBe(slowChat.agentId);
    expect(facts((await scheduler.runNow("bot-q", "rt-slow")).run)).toBe("canceled/unknown/skipped-busy");
    started();
    expect((await slowRun).run).toMatchObject({ executionStatus: "running", agentId: slowChat.agentId });
    const { routines } = await scheduler.status();
    expect(routines["rt-slow"]?.runs.map(facts)).toEqual([
      "running/unknown",
      "canceled/unknown/skipped-busy",
    ]);
  });

  it("finishes a run whose turn ends before chat creation returns", async () => {
    const fast = routine({
      id: "rt-fast",
      schedule: { kind: "webhook" },
      resultsChatId: "fast-results",
    });
    const { scheduler, appended } = await startScheduler(
      [makeBot({ id: "bot-f", routines: [fast] })],
      async (prepared) => {
        await scheduler.finished("rt-fast", prepared.agentId, {
          outcome: { kind: "failed", error: { message: "No credits left." } },
          reply: "",
          sessionEpoch: observedEpochs.get(prepared.agentId),
        });
        return prepared.agentId;
      },
    );
    await scheduler.runNow("bot-f", "rt-fast");
    expect((await runsOf(scheduler, "rt-fast"))[0]?.agentId).toMatch(/^[0-9a-f-]{36}$/);
    const { routines } = await scheduler.status();
    expect(routines["rt-fast"]?.runs.map((run) => [facts(run), run.error])).toEqual([
      ["failed/unknown", "No credits left."],
    ]);
    expect(appended.at(-1)?.item.data).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      error: "No credits left.",
    });
  });
});

describe("the routine scheduler's saved state", () => {
  useSchedulerHome("paseo-bots-scheduler-state-");

  it("sets a broken routines.json aside instead of overwriting the run history", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = '{"rt-1": {"lastRunAt": "2026-09-2';
    await writeState("routines.json", broken);
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-s", routines: [routine({ createdAt: new Date().toISOString() })] })],
      launchAssigned,
    );
    await scheduler.runNow("bot-s", "rt-1");
    expect(await setAside("routines.json")).toEqual([broken]);
    expect((await scheduler.status()).routines["rt-1"]?.runs.map(facts)).toEqual(["running/unknown"]);
  });

  it("sets a broken webhooks.json aside instead of overwriting the secrets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await writeState("webhooks.json", '{"rt-hook": "ab');
    const hook = routine({ id: "rt-hook", schedule: { kind: "webhook" } });
    const { scheduler } = await startScheduler([makeBot({ id: "bot-w", routines: [hook] })], launchAssigned);
    expect((await scheduler.webhookUrl("rt-hook")).url).toMatch(/\/hooks\/rt-hook\/[a-f0-9]{48}$/);
    expect(await setAside("webhooks.json")).toEqual(['{"rt-hook": "ab']);
  });

  it("gives two callers asking at once the same saved webhook secret", async () => {
    const hook = routine({ id: "rt-race", schedule: { kind: "webhook" } });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-race", routines: [hook] })],
      launchAssigned,
    );
    const [first, second] = await Promise.all([
      scheduler.webhookUrl("rt-race"),
      scheduler.webhookUrl("rt-race"),
    ]);
    expect(second.url).toBe(first.url);
    const saved = JSON.parse(await readFile(join(pluginDataPath(), "webhooks.json"), "utf8"));
    expect(first.url.endsWith(`/${saved["rt-race"]}`)).toBe(true);
  });

  it("replaces a saved webhook secret of the wrong length or type instead of failing on it", async () => {
    await writeState("webhooks.json", JSON.stringify({ "rt-short": "abc123", "rt-num": 42 }));
    const { scheduler, relay } = await startScheduler(
      [makeBot({ id: "bot-sec", routines: [webhook({ id: "rt-short" }), webhook({ id: "rt-num" })] })],
      launchAssigned,
      undefined,
      { capacity: concurrentCapacity },
    );
    const guess = `http://127.0.0.1:${await relay.start()}/hooks/rt-short/${"a".repeat(48)}`;
    expect((await hook(guess))[0]).toBe(404);
    for (const id of ["rt-short", "rt-num"]) {
      const { url } = await scheduler.webhookUrl(id);
      expect(url).toMatch(new RegExp(`/hooks/${id}/[a-f0-9]{48}$`));
      expect(await hook(url, "event")).toEqual([
        202,
        { status: "running", chat: expect.stringMatching(/^[0-9a-f-]{36}$/) },
      ]);
    }
  });
});

const fresh = () => new Date().toISOString();
const webhook = (patch: Partial<Routine> = {}) => routine({ schedule: { kind: "webhook" }, ...patch });

async function runsOf(scheduler: RoutineScheduler, routineId: string) {
  return (await scheduler.status()).routines[routineId]?.runs ?? [];
}

async function hook(
  url: string,
  body?: string,
  headers?: Record<string, string>,
): Promise<[number, unknown]> {
  const answer = await fetch(url, { method: "POST", body, headers });
  return [answer.status, await answer.json()];
}

/** Declares a body without sending it. */
function declareBody(url: string, bytes: number): Promise<[number, string]> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, {
      method: "POST",
      headers: { "content-length": String(bytes) },
      agent: false,
    });
    request.on("error", reject);
    request.on("response", (response) => {
      request.off("error", reject).on("error", () => undefined);
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("close", () => resolve([response.statusCode ?? 0, body]));
    });
    request.flushHeaders();
  });
}

describe("webhook event prompts", () => {
  it("cuts a long body and marks an empty one", () => {
    const event = { contentType: null, receivedAt: "2026-09-27T10:00:00.000Z" };
    const long = runPrompt(routine(), { ...event, body: "x".repeat(50_000) });
    expect(long).toContain(`\n${"x".repeat(48_000)}\n[cut at 48000 characters]\n[END WEBHOOK EVENT DATA]`);
    expect(long).not.toContain("x".repeat(48_001));
    expect(runPrompt(routine(), { ...event, body: "  \n " })).toContain(
      "Content type: unknown\n\n(empty body)\n[END WEBHOOK EVENT DATA]",
    );
  });
});

describe("routine runs that can't start", () => {
  useSchedulerHome("paseo-bots-scheduler-fails-");

  it("keeps uncertain launch effects reserved and does not launch the next occurrence", async () => {
    const launch = vi.fn<Launch>(async () => {
      throw new Error("Creation transport lost.");
    });
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-x",
          routines: [routine({ id: "rt-x", resultsChatId: "x-results", createdAt: fresh() })],
        }),
      ],
      launch,
    );
    const first = (await scheduler.runNow("bot-x", "rt-x")).run;
    expect(first).toMatchObject({
      executionStatus: "unknown",
      taskOutcome: "unknown",
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      error: "Creation transport lost.",
      endedAt: null,
      managed: { reservation: true },
    });
    expect(facts((await scheduler.runNow("bot-x", "rt-x")).run)).toBe("canceled/no_change/skipped-busy");
    await scheduler.coordinator.pump();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(appended.map((card) => [facts(card.item.data), card.item.data.error])).toEqual([
      ["unknown/unknown", "Creation transport lost."],
    ]);
    expect((await runsOf(scheduler, "rt-x"))[0]).toMatchObject({
      agentId: first.agentId,
      executionStatus: "unknown",
      managed: { reservation: true },
    });
  });

  it("fails runs of bots stored on another host and leaves them and archived bots off the schedule", async () => {
    const due = { schedule: { kind: "interval", minutes: 30 } as const, createdAt: hoursAgo(1) };
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-away",
          hostId: "laptop",
          executionMode: "legacy",
          routines: [routine({ ...due, id: "rt-away", resultsChatId: "away-results" })],
        }),
        makeBot({ id: "bot-old", archived: true, routines: [routine({ ...due, id: "rt-old" })] }),
        makeBot({ id: "bot-here", routines: [routine({ ...due, id: "rt-here" })] }),
      ],
      launchAssigned,
    );
    await vi.waitFor(async () => expect(await runsOf(scheduler, "rt-here")).toHaveLength(1));
    const { routines } = await scheduler.status();
    expect([routines["rt-away"], routines["rt-old"]]).toEqual([undefined, undefined]);
    const { run } = await scheduler.runNow("bot-away", "rt-away");
    expect(run).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      agentId: null,
      error: expect.stringContaining("another host"),
    });
    expect(appended.map((card) => [card.agentId, facts(card.item.data)])).toEqual([
      ["away-results", "failed/unknown"],
    ]);
  });

  it("says when the bot or routine doesn't exist", async () => {
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-n", routines: [routine({ id: "rt-n", createdAt: fresh() })] })],
      launchAssigned,
    );
    await expect(scheduler.runNow("bot-n", "rt-gone")).rejects.toThrow("Routine not found.");
    await expect(scheduler.runNow("bot-gone", "rt-n")).rejects.toThrow("Routine not found.");
  });
});

describe("routine runs already in progress", () => {
  useSchedulerHome("paseo-bots-scheduler-busy-");

  it.each(["idle", "unreachable"])(
    "retains capacity when the host is %s without terminal evidence",
    async (state) => {
      const launch = vi.fn(launchAssigned);
      const { scheduler, status, unreachable } = await startScheduler(
        [makeBot({ id: "bot-b", routines: [routine({ id: "rt-b", createdAt: fresh() })] })],
        launch,
      );
      const first = (await scheduler.runNow("bot-b", "rt-b")).run;
      const agentId = defined(first.agentId, "admitted agent");
      status.set(agentId, "idle");
      if (state === "unreachable") unreachable.add(agentId);
      await scheduler.coordinator.reconcile(first.id);
      expect((await runsOf(scheduler, "rt-b"))[0]).toMatchObject({
        agentId,
        executionStatus: "unknown",
        endedAt: null,
        managed: { reservation: true },
      });
      expect(facts((await scheduler.runNow("bot-b", "rt-b")).run)).toBe("canceled/unknown/skipped-busy");
      await scheduler.coordinator.pump();
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  it("finishes a canceled turn once and ignores turns of other chats", async () => {
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-c",
          routines: [routine({ id: "rt-c", resultsChatId: "c-results", createdAt: fresh() })],
        }),
      ],
      launchAssigned,
    );
    const agentId = defined((await scheduler.runNow("bot-c", "rt-c")).run.agentId, "cancel agent");
    const turn = (outcome: PluginTurnOutcome, reply: string) => ({
      outcome,
      reply,
      sessionEpoch: observedEpochs.get(agentId),
    });
    await scheduler.finished("rt-c", "stranger-chat", turn({ kind: "completed" }, "Not mine."));
    await scheduler.finished("rt-unknown", agentId, turn({ kind: "completed" }, "No such routine."));
    await scheduler.finished("rt-c", agentId, turn({ kind: "canceled", reason: "user" }, "  "));
    await scheduler.finished("rt-c", agentId, turn({ kind: "completed" }, "Too late."));
    // A canceled turn may have changed things before it stopped, so its outcome is unknown rather than none.
    expect((await runsOf(scheduler, "rt-c")).map((run) => [facts(run), run.output, run.error])).toEqual([
      ["canceled/unknown", null, "Stopped before it finished."],
    ]);
    expect((await scheduler.status()).routines["rt-unknown"]).toBeUndefined();
    expect(appended.map((card) => facts(card.item.data))).toEqual(["running/unknown", "canceled/unknown"]);
  });

  it("records a run that ends after its routine was deleted, without a card", async () => {
    const { scheduler, appended, host } = await startScheduler(
      [
        makeBot({
          id: "bot-d",
          routines: [routine({ id: "rt-d", resultsChatId: "d-results", createdAt: fresh() })],
        }),
      ],
      launchAssigned,
    );
    const agentId = defined((await scheduler.runNow("bot-d", "rt-d")).run.agentId, "deleted routine agent");
    defined(defined(await host.values(), "settings").bots[0], "bot").routines = [];
    await scheduler.finished("rt-d", agentId, {
      outcome: { kind: "completed" },
      reply: "Done anyway.",
      sessionEpoch: observedEpochs.get(agentId),
    });
    expect((await runsOf(scheduler, "rt-d")).map((run) => [facts(run), run.output])).toEqual([
      ["completed/unknown", "Done anyway."],
    ]);
    expect(appended.map((card) => facts(card.item.data))).toEqual(["running/unknown"]);
  });
});

describe("routine display retention", () => {
  useSchedulerHome("paseo-bots-scheduler-retention-");

  it("keeps 30 terminal runs plus unfinished work until it settles", async () => {
    const old = Array.from({ length: 30 }, (_, index) => makeRun(`old-${index}`));
    await writeState("routines.json", JSON.stringify({ "rt-k": { lastRunAt: null, runs: old } }));
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-k", routines: [routine({ id: "rt-k", createdAt: fresh() })] })],
      launchAssigned,
    );
    const { run } = await scheduler.runNow("bot-k", "rt-k");
    const ids = (await runsOf(scheduler, "rt-k")).map((entry) => entry.id);
    expect(ids).toHaveLength(31);
    expect([ids[0], ids.at(-1)]).toEqual(["old-0", run.id]);
    await scheduler.finished("rt-k", defined(run.agentId, "retained agent"), {
      outcome: { kind: "completed" },
      reply: "Finished.",
      sessionEpoch: observedEpochs.get(defined(run.agentId, "retained agent")),
    });
    const settled = (await runsOf(scheduler, "rt-k")).map((entry) => entry.id);
    expect(settled).toHaveLength(30);
    expect([settled[0], settled.at(-1)]).toEqual(["old-1", run.id]);
  });
});

describe("routine history saved earlier", () => {
  useSchedulerHome("paseo-bots-scheduler-history-");

  it("reads history saved by older versions", async () => {
    const at = "2026-09-20T09:00:00.000Z";
    const legacy = {
      "rt-failed": { lastRunAt: at, lastStatus: "failed", lastError: "Timed out.", lastAgentId: "old-chat" },
      "rt-missed": { lastRunAt: at, lastStatus: "skipped-missed" },
      "rt-odd": { lastRunAt: at, lastStatus: "something else" },
      "rt-never": { lastRunAt: null },
    };
    await writeState("routines.json", JSON.stringify(legacy));
    const { scheduler } = await startScheduler([]);
    const { routines } = await scheduler.status();
    expect(routines["rt-failed"]).toMatchObject({
      lastRunAt: at,
      runs: [
        {
          id: "legacy",
          trigger: "schedule",
          scheduledFor: at,
          startedAt: at,
          endedAt: null,
          executionStatus: "failed",
          taskOutcome: "unknown",
          agentId: "old-chat",
          error: "Timed out.",
        },
      ],
    });
    const summary = (id: string) => routines[id]?.runs.map((run) => [facts(run), run.agentId, run.error]);
    expect(summary("rt-missed")).toEqual([["canceled/unknown/skipped-missed", null, null]]);
    // A status this version doesn't know is not read as a success.
    expect(summary("rt-odd")).toEqual([["unknown/unknown", null, null]]);
    expect(routines["rt-never"]).toEqual({ lastRunAt: null, runs: [] });
  });

  it("never infers completion from the age of unfinished history", async () => {
    const runs = [
      makeRun("lost", { executionStatus: "running", startedAt: hoursAgo(13), endedAt: null }),
      makeRun("recent", { executionStatus: "running", startedAt: hoursAgo(11), endedAt: null }),
    ];
    await writeState("routines.json", JSON.stringify({ "rt-s": { lastRunAt: null, runs } }));
    const launch = vi.fn(launchAssigned);
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-s", routines: [routine({ id: "rt-s", createdAt: fresh() })] })],
      launch,
    );
    expect((await runsOf(scheduler, "rt-s")).map((run) => [run.id, run.endedAt])).toEqual([
      ["lost", null],
      ["recent", null],
    ]);
    expect(facts((await scheduler.runNow("bot-s", "rt-s")).run)).toBe("canceled/no_change/skipped-busy");
    expect(launch).not.toHaveBeenCalled();
  });

  it("reads null entries and runs as empty and records the next run over them", async () => {
    const saved = { "rt-null": null, "rt-holes": { lastRunAt: null, runs: [null, makeRun("kept")] } };
    await writeState("routines.json", JSON.stringify(saved));
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-null", routines: [routine({ id: "rt-null", createdAt: fresh() })] })],
      launchAssigned,
    );
    expect((await runsOf(scheduler, "rt-holes")).map((run) => run.id)).toEqual(["kept"]);
    expect(await runsOf(scheduler, "rt-null")).toEqual([]);
    const { run } = await scheduler.runNow("bot-null", "rt-null");
    expect(run.executionStatus).toBe("running");
    expect((await runsOf(scheduler, "rt-null")).map((entry) => entry.agentId)).toEqual([run.agentId]);
  });
});

describe("routine webhook calls", () => {
  useSchedulerHome("paseo-bots-scheduler-hooks-");

  it("turns away calls for paused, archived and scheduled routines, and malformed links", async () => {
    const { scheduler } = await startScheduler(
      [
        makeBot({
          id: "bot-h",
          routines: [
            webhook({ id: "rt-paused", enabled: false }),
            routine({ id: "rt-timed", createdAt: fresh() }),
          ],
        }),
        makeBot({ id: "bot-shelved", archived: true, routines: [webhook({ id: "rt-shelved" })] }),
      ],
      launchAssigned,
    );
    const notFound = [404, { error: "not found" }];
    const call = async (routineId: string) => hook((await scheduler.webhookUrl(routineId)).url);
    expect(await call("rt-paused")).toEqual([409, { error: "The routine is paused." }]);
    expect(await call("rt-shelved")).toEqual(notFound);
    expect(await call("rt-timed")).toEqual(notFound);
    expect(await hook((await scheduler.webhookUrl("rt-paused")).url.slice(0, -1))).toEqual(notFound);
    expect(await runsOf(scheduler, "rt-paused")).toEqual([]);
  });

  // Ten serial loopback admissions each synchronize durable metadata; this is not the rate-window bound.
  it("takes ten calls a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-t", routines: [webhook({ id: "rt-many" })] })],
      launchAssigned,
    );
    const { url } = await scheduler.webhookUrl("rt-many");
    const answers: number[] = [];
    for (let call = 0; call < 10; call++) {
      answers.push((await hook(url, `event ${call}`))[0]);
      const active = (await runsOf(scheduler, "rt-many")).find((run) => run.executionStatus === "running");
      await scheduler.finished("rt-many", defined(active?.agentId, "rate-limited agent"), {
        outcome: { kind: "completed" },
        reply: "Accepted.",
        sessionEpoch: observedEpochs.get(defined(active?.agentId, "rate-limited agent")),
      });
    }
    expect(answers).toEqual(Array(10).fill(202));
    expect(await hook(url, "one more")).toEqual([429, { error: "Too many calls this minute." }]);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await hook(url, "next minute"))[0]).toBe(202);
    expect(await runsOf(scheduler, "rt-many")).toHaveLength(11);
  }, 15_000);
});

describe("routine webhook bodies and creation", () => {
  useSchedulerHome("paseo-bots-scheduler-hook-bodies-");

  it("answers 413 to a body over 256 KB and hands an empty one over as marked", async () => {
    const launched: PreparedBotChat[] = [];
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-e", routines: [webhook({ id: "rt-empty" })] })],
      async (prepared) => {
        launched.push(prepared);
        return prepared.agentId;
      },
    );
    const { url } = await scheduler.webhookUrl("rt-empty");
    expect(await declareBody(url, 300 * 1024)).toEqual([
      413,
      JSON.stringify({ error: "Send at most 256 KB." }),
    ]);
    expect(await hook(url)).toEqual([
      202,
      { status: "running", chat: expect.stringMatching(/^[0-9a-f-]{36}$/) },
    ]);
    expect(launched.map((chat) => chat.prompt)).toEqual([
      expect.stringContaining("Content type: unknown\n\n(empty body)\n"),
    ]);
  });

  it("turns away a wrong secret or a paused routine before reading any of the body", async () => {
    const { scheduler } = await startScheduler(
      [
        makeBot({
          id: "bot-g",
          routines: [webhook({ id: "rt-guard" }), webhook({ id: "rt-off", enabled: false })],
        }),
      ],
      launchAssigned,
    );
    const { url } = await scheduler.webhookUrl("rt-guard");
    const forged = url.replace(/[a-f0-9]{48}$/, "0".repeat(48));
    const endless = 10 * 1024 ** 3;
    expect(await declareBody(forged, endless)).toEqual([404, JSON.stringify({ error: "not found" })]);
    expect(await declareBody((await scheduler.webhookUrl("rt-off")).url, endless)).toEqual([
      409,
      JSON.stringify({ error: "The routine is paused." }),
    ]);
    expect(await runsOf(scheduler, "rt-guard")).toEqual([]);
  });

  it("reports unknown creation without claiming the admitted UUID is a created chat", async () => {
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-500", routines: [webhook({ id: "rt-500" })] })],
      () => Promise.reject(new Error("Creation transport lost.")),
    );
    const { url } = await scheduler.webhookUrl("rt-500");
    expect(await hook(url, "event")).toEqual([
      500,
      {
        status: "failed",
        error: "Creation transport lost.",
      },
    ]);
    expect((await runsOf(scheduler, "rt-500"))[0]).toMatchObject({
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      executionStatus: "unknown",
      managed: { reservation: true },
    });
  });
});

describe("overlapping routine webhook calls", () => {
  useSchedulerHome("paseo-bots-scheduler-overlap-");

  it("lets three webhook runs be unfinished at once while their cards post", async () => {
    const launched: string[] = [];
    let posted: () => void = () => {};
    const { scheduler, posting } = await startScheduler(
      [makeBot({ id: "bot-p", routines: [webhook({ id: "rt-p", resultsChatId: "p-results" })] })],
      async (prepared) => {
        launched.push(prepared.agentId);
        return prepared.agentId;
      },
      undefined,
      { capacity: concurrentCapacity },
    );
    posting.until = new Promise((resolve) => {
      posted = resolve;
    });
    const { url } = await scheduler.webhookUrl("rt-p");
    const calls: Promise<[number, unknown]>[] = [];
    for (const count of [1, 2, 3]) {
      calls.push(hook(url, `event ${count}`));
      await vi.waitFor(() => expect(launched).toHaveLength(count));
    }
    expect(await hook(url, "event 4")).toEqual([429, { status: "skipped-busy" }]);
    posted();
    expect(await Promise.all(calls)).toEqual(
      launched.map((agentId) => [202, { status: "running", chat: agentId }]),
    );
  });
});

/** Settings reads, fs and HTTP keep real timers; only the scheduler's clock is faked. */
function fakeSchedulerClock() {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
}

function catchUpThenTick() {
  fakeSchedulerClock();
  // 2026-09-28 is a Monday.
  vi.setSystemTime(local(28, 12));
  const daily = routine({
    id: "rt-daily",
    name: "Daily",
    schedule: { kind: "daily", time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    createdAt: local(27, 0).toISOString(),
  });
  const minutely = routine({
    id: "rt-minutely",
    name: "Minutely",
    schedule: { kind: "interval", minutes: 1 },
    createdAt: local(28, 12).toISOString(),
  });
  const host = fakeHost([makeBot({ id: "bot-clock", routines: [daily, minutely] })]);
  const launched: string[] = [];
  const { scheduler } = track(
    host,
    async (prepared) => {
      launched.push(defined(prepared.title, "routine title"));
      return prepared.agentId;
    },
    { capacity: concurrentCapacity },
  );
  return { host, scheduler, launched };
}

describe("the routine clock", () => {
  useSchedulerHome("paseo-bots-scheduler-clock-");

  it("catches up a run missed while Paseo was closed, then ticks every 30 seconds until stopped", async () => {
    const { host, scheduler, launched } = catchUpThenTick();
    expect((await scheduler.status()).scheduler).toBe(false);
    host.attach(fakePaseo().api);
    await vi.waitFor(() => expect(launched).toEqual(["Daily"]));
    expect((await runsOf(scheduler, "rt-daily")).map((run) => [run.trigger, run.scheduledFor])).toEqual([
      ["schedule", local(28, 9).toISOString()],
    ]);
    await vi.waitFor(() => {
      vi.advanceTimersByTime(30_000);
      expect(launched).toEqual(["Daily", "Minutely"]);
    });
    host.attach(fakePaseo().api);
    await scheduler.stop();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect((await scheduler.status()).scheduler).toBe(true);
    host.attach(fakePaseo().api);
    vi.advanceTimersByTime(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(launched).toEqual(["Daily", "Minutely"]);
  });

  it("recovers from a tick that fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fakeSchedulerClock();
    const due = routine({
      id: "rt-flaky",
      schedule: { kind: "interval", minutes: 30 },
      createdAt: hoursAgo(1),
    });
    const values = {
      bots: [makeBot({ id: "bot-flaky", routines: [due] })],
      history: [],
      library: EMPTY_LIBRARY,
    };
    const reads = [
      async () => {
        throw new Error("state.json is locked.");
      },
    ];
    const ready = async () => ({ values, revision: "1" });
    const host = new BotsHost({ read: () => (reads.shift() ?? ready)() } as never);
    const launched: string[] = [];
    track(host, async (prepared) => {
      launched.push(defined(prepared.title, "routine title"));
      return prepared.agentId;
    });
    host.attach(fakePaseo().api);
    await vi.waitFor(() => {
      vi.advanceTimersByTime(30_000);
      expect(launched).toEqual(["Inbox check"]);
    });
  });

  it("finishes the tick under way before it says it stopped", async () => {
    const events = new EventEmitter();
    const launching = once(events, "launch");
    const due = routine({ id: "rt-z", schedule: { kind: "interval", minutes: 30 }, createdAt: hoursAgo(1) });
    let agentId = "";
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-z", routines: [due] })],
      async (prepared) => {
        agentId = prepared.agentId;
        events.emit("launch");
        await once(events, "started");
        return prepared.agentId;
      },
    );
    await launching;
    const stopped = scheduler.stop();
    events.emit("started");
    await stopped;
    expect((await runsOf(scheduler, "rt-z")).map((run) => run.agentId)).toEqual([agentId]);
  });
});

describe("legacy routine execution without managed accounting", () => {
  useSchedulerHome("paseo-bots-scheduler-legacy-");

  it("preserves host-idle and unreachable overlap behavior for bots without an opt-in", async () => {
    const launch = vi.fn(launchAssigned);
    const { scheduler, status, unreachable } = await startScheduler(
      [makeBot({ id: "legacy", executionMode: undefined, routines: [routine({ createdAt: fresh() })] })],
      launch,
    );
    const first = (await scheduler.runNow("legacy", "rt-1")).run;
    const second = (await scheduler.runNow("legacy", "rt-1")).run;
    expect(first.managed ?? null).toBeNull();
    expect(second).toMatchObject({ executionStatus: "running", taskOutcome: "unknown" });
    expect(second.agentId).not.toBe(first.agentId);
    const secondAgent = defined(second.agentId, "second legacy agent");
    status.set(secondAgent, "initializing");
    expect(facts((await scheduler.runNow("legacy", "rt-1")).run)).toBe("canceled/no_change/skipped-busy");
    unreachable.add(secondAgent);
    const third = (await scheduler.runNow("legacy", "rt-1")).run;
    expect(third.executionStatus).toBe("running");
    expect(launch).toHaveBeenCalledTimes(3);
    await scheduler.finished("rt-1", defined(third.agentId, "third legacy agent"), {
      outcome: { kind: "completed" },
      reply: "I claim success.",
    });
    expect((await runsOf(scheduler, "rt-1")).at(-1)).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      verification: null,
    });
  });

  it("reports a failed legacy launch without creating a managed reservation or blocking a new request", async () => {
    let calls = 0;
    const { scheduler } = await startScheduler(
      [makeBot({ id: "legacy", executionMode: "legacy", routines: [routine({ createdAt: fresh() })] })],
      async (prepared) => {
        if (++calls === 1) throw new Error("Legacy launch failed.");
        return prepared.agentId;
      },
    );
    const first = (await scheduler.runNow("legacy", "rt-1")).run;
    expect(first).toMatchObject({
      executionStatus: "failed",
      taskOutcome: "unknown",
      agentId: null,
      error: "Legacy launch failed.",
    });
    expect(first.managed ?? null).toBeNull();
    const second = (await scheduler.runNow("legacy", "rt-1")).run;
    expect(second.executionStatus).toBe("running");
    expect(second.managed ?? null).toBeNull();
    expect(calls).toBe(2);
  });
});

describe("legacy webhook overlap and execution mode changes", () => {
  useSchedulerHome("paseo-bots-scheduler-legacy-overlap-");

  it("allows three unfinished legacy webhooks without applying managed provider capacity", async () => {
    const { scheduler, status } = await startScheduler(
      [makeBot({ id: "legacy", executionMode: "legacy", routines: [webhook()] })],
      async (prepared) => {
        status.set(prepared.agentId, "running");
        return prepared.agentId;
      },
    );
    const { url } = await scheduler.webhookUrl("rt-1");
    for (const event of ["one", "two", "three"]) expect((await hook(url, event))[0]).toBe(202);
    expect(await hook(url, "four")).toEqual([429, { status: "skipped-busy" }]);
    const active = (await runsOf(scheduler, "rt-1")).filter((run) => run.executionStatus === "running");
    expect(active).toHaveLength(3);
    expect(active.every((run) => !run.managed)).toBe(true);
  });

  it.each([
    { from: "legacy", to: "managed" },
    { from: "managed", to: "legacy" },
  ] as const)("does not duplicate unfinished work when switching $from to $to", async ({ from, to }) => {
    const launch = vi.fn(launchAssigned);
    const { scheduler, host } = await startScheduler(
      [makeBot({ id: "switching", executionMode: from, routines: [webhook()] })],
      launch,
    );
    const first = (await scheduler.runNow("switching", "rt-1")).run;
    defined((await host.values()).bots[0], "mutable bot").executionMode = to;
    const { url } = await scheduler.webhookUrl("rt-1");
    expect(await hook(url, "new request")).toEqual([429, { status: "skipped-busy" }]);
    expect((await runsOf(scheduler, "rt-1"))[0]?.agentId).toBe(first.agentId);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("routine request receipts before mutable configuration", () => {
  useSchedulerHome("paseo-bots-scheduler-replay-");

  it.each(["legacy", "managed"] as const)(
    "replays a %s manual request after its bot was deleted",
    async (executionMode) => {
      const launch = vi.fn(launchAssigned);
      const { scheduler, host } = await startScheduler(
        [makeBot({ id: "replay", executionMode, routines: [webhook()] })],
        launch,
      );
      const first = (await scheduler.runNow("replay", "rt-1", "manual-request")).run;
      (await host.values()).bots = [];
      const replay = (await scheduler.runNow("replay", "rt-1", "manual-request")).run;
      expect([replay.id, replay.agentId]).toEqual([first.id, first.agentId]);
      expect(launch).toHaveBeenCalledTimes(1);
      await expect(scheduler.runNow("replay", "rt-1", "another-request")).rejects.toThrow(
        "Routine not found.",
      );
    },
  );

  it.each(["legacy", "managed"] as const)(
    "rejects a changed %s webhook body beyond the prompt cut",
    async (executionMode) => {
      const launch = vi.fn(launchAssigned);
      const { scheduler, host } = await startScheduler(
        [makeBot({ id: "replay", executionMode, routines: [webhook()] })],
        launch,
      );
      const { url } = await scheduler.webhookUrl("rt-1");
      const headers = { "idempotency-key": "original", "content-type": "application/json" };
      const body = `${"x".repeat(48_000)}original tail`;
      const first = await hook(url, body, headers);
      expect(first[0]).toBe(202);
      defined((await host.values()).bots[0]?.routines[0], "mutable routine").enabled = false;
      expect(await hook(url, body, headers)).toEqual(first);
      (await host.values()).bots = [];
      expect(await hook(url, body, headers)).toEqual(first);
      expect((await hook(url, `${"x".repeat(48_000)}changed tail`, headers))[0]).toBe(409);
      expect((await hook(url, body, { ...headers, "content-type": "text/plain" }))[0]).toBe(409);
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("independent webhook identities", () => {
  useSchedulerHome("paseo-bots-scheduler-webhook-identities-");

  it.each(["legacy", "managed"] as const)(
    "retains two identical %s bodies under distinct keys",
    async (executionMode) => {
      const { scheduler } = await startScheduler([
        makeBot({ id: "events", executionMode, routines: [webhook()] }),
      ]);
      const { url } = await scheduler.webhookUrl("rt-1");
      expect((await hook(url, "same event", { "idempotency-key": "first" }))[0]).toBe(202);
      expect((await hook(url, "same event", { "idempotency-key": "second" }))[0]).toBe(202);
      const rows = await runsOf(scheduler, "rt-1");
      expect(rows).toHaveLength(2);
      expect(rows[0]?.occurrenceKey).not.toBe(rows[1]?.occurrenceKey);
      expect(rows[0]?.id).not.toBe(rows[1]?.id);
    },
  );
});

describe("legacy fixed policy resolution", () => {
  useSchedulerHome("paseo-bots-scheduler-legacy-policy-");

  it.each([
    { overrides: undefined, expected: "policy-model" },
    { overrides: { model: "routine-model" }, expected: "routine-model" },
  ])("preserves B04 selection $expected using one captured state", async ({ overrides, expected }) => {
    const entries = LIVE_PROVIDERS.map((entry) =>
      entry.provider === "claude"
        ? {
            ...entry,
            models: ["base-model", "policy-model", "routine-model", "new-model"].map((id) => ({
              id,
              label: id,
            })),
          }
        : entry,
    );
    const api = { providers: { snapshot: async () => ({ entries }) } } as unknown as ChatApi;
    const launched: PreparedBotChat[] = [];
    const { scheduler, host } = await startScheduler(
      [
        makeBot({
          id: "legacy",
          executionMode: "legacy",
          model: "base-model",
          policy: { binding: null, inherit: ["model", "thinkingOptionId"] },
          routines: [webhook({ overrides })],
        }),
      ],
      async (prepared) => {
        launched.push(prepared);
        return prepared.agentId;
      },
      undefined,
      {
        prepare: async (_host, _relay, bot, input) => {
          const state = defined(input.state, "captured state");
          mutable.policies = [];
          mutable.globalPolicy = null;
          defined(mutable.bots[0]?.routines[0], "mutable routine").overrides = { model: "new-model" };
          return prepareBotChat(api, {
            ...input,
            bot,
            policy: state,
            library: state.library ?? EMPTY_LIBRARY,
            placement: { path: "/tmp/legacy-policy-fixture", projectRoot: null },
            systemPrompt: "Admitted instructions.",
          });
        },
      },
    );
    const mutable = await host.values();
    mutable.policies = [
      PolicySchema.parse({
        id: "pol-legacy",
        revision: 1,
        createdAt: fresh(),
        name: "Explicit policy",
        roles: { executor: { provider: "claude", model: "policy-model" } },
      }),
    ];
    mutable.globalPolicy = { policyId: "pol-legacy", revision: 1 };
    const first = (await scheduler.runNow("legacy", "rt-1", "frozen-request")).run;
    expect(launched[0]?.model).toBe(expected);
    expect(first.managed ?? null).toBeNull();
    const replay = (await scheduler.runNow("legacy", "rt-1", "frozen-request")).run;
    expect([replay.id, replay.agentId]).toEqual([first.id, first.agentId]);
    expect(launched).toHaveLength(1);
  });
});

describe("managed routine queue deadlines", () => {
  useSchedulerHome("paseo-bots-scheduler-deadline-");

  it("expires unlaunched work relative to its due instant without releasing active capacity", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const launch = vi.fn(launchAssigned);
    const { scheduler } = await startScheduler(
      [
        makeBot({ id: "active", routines: [webhook({ id: "rt-active" })] }),
        makeBot({
          id: "waiting",
          routines: [webhook({ id: "rt-waiting", runtime: { deadlineSeconds: 1 } })],
        }),
      ],
      launch,
      undefined,
      { capacity: { global: 1 } },
    );
    const active = (await scheduler.runNow("active", "rt-active")).run;
    const waiting = (await scheduler.runNow("waiting", "rt-waiting")).run;
    expect(waiting.executionStatus).toBe("queued");
    vi.setSystemTime(Date.now() + 1001);
    await scheduler.coordinator.pump();
    expect(await scheduler.coordinator.get(waiting.id)).toMatchObject({
      executionStatus: "canceled",
      taskOutcome: "no_change",
      managed: { reservation: false },
    });
    expect((await scheduler.coordinator.get(active.id))?.managed?.reservation).toBe(true);
    expect(launch).toHaveBeenCalledTimes(1);
  });
});

describe("legacy terminal evidence during launch", () => {
  useSchedulerHome("paseo-bots-scheduler-legacy-early-end-");

  it("preserves completion and agent identity when the create reply fails after the turn ended", async () => {
    let agentId = "";
    const { scheduler } = await startScheduler(
      [makeBot({ id: "legacy", executionMode: "legacy", routines: [webhook()] })],
      async (prepared) => {
        agentId = prepared.agentId;
        await scheduler.finished("rt-1", agentId, {
          outcome: { kind: "completed" },
          reply: "Observed completed work.",
        });
        throw new Error("Creation reply was lost after completion.");
      },
    );
    const { run } = await scheduler.runNow("legacy", "rt-1");
    expect(run).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      agentId,
      output: "Observed completed work.",
    });
    expect(run.managed ?? null).toBeNull();
  });
});

describe("managed routine completion provenance", () => {
  useSchedulerHome("paseo-bots-scheduler-completion-epoch-");

  it("does not free capacity for a completion that omitted its observed provider-session epoch", async () => {
    const { scheduler } = await startScheduler([makeBot({ id: "epoch", routines: [webhook()] })]);
    const { run } = await scheduler.runNow("epoch", "rt-1");
    await scheduler.finished("rt-1", defined(run.agentId, "managed agent"), {
      outcome: { kind: "completed" },
      reply: "Unattributed completion.",
    });
    expect(await scheduler.coordinator.get(run.id)).toMatchObject({
      executionStatus: "unknown",
      taskOutcome: "unknown",
      managed: { reservation: true },
    });
    expect(facts((await scheduler.runNow("epoch", "rt-1")).run)).toBe("canceled/no_change/skipped-busy");
  });
});
