import { EventEmitter, once } from "node:events";
import { readdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import type { startChat } from "../server/chats";
import { writeAtomic } from "../server/files";
import { BotsHost } from "../server/host";
import { Relay } from "../server/relay";
import { RoutineScheduler, runPrompt } from "../server/scheduler";
import { type Bot, EMPTY_LIBRARY, type Routine } from "../shared/bot";
import { scheduleFrom, upcomingRuns } from "../shared/routines";
import type { RoutineRun } from "../shared/rpc";
import { defined, fakeHost, makeBot, useTempPaseoHome } from "./helpers";

const local = (day: number, hour: number, minute = 0) => new Date(2026, 8, day, hour, minute);

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

type Launch = typeof startChat;
interface Card {
  agentId: string;
  item: { id: string; kind: string; data: { status: string; output: string | null; error: string | null } };
}

/** Cards wait for `posting.until`; cards posted to `brokenChat` throw, like a results chat that's gone. */
function fakePaseo(brokenChat?: string) {
  const appended: Card[] = [];
  const status = new Map<string, string>();
  const unreachable = new Set<string>();
  const posting = { until: Promise.resolve() };
  const api = {
    agents: {
      ref: (agentId: string) => ({
        refresh: async () => {
          if (unreachable.has(agentId)) throw new Error("Paseo didn't answer.");
          return { agent: { status: status.get(agentId) ?? "idle", archivedAt: null } };
        },
        timeline: {
          append: async (item: never) => {
            await posting.until;
            if (agentId === brokenChat) throw new Error("That chat is gone.");
            appended.push({ agentId, item });
          },
        },
      }),
    },
  } as never;
  return { api, appended, status, unreachable, posting };
}

/** Every scheduler and relay a test makes; each test waits for them to stop before the next one starts. */
const running: { stop(): Promise<void> }[] = [];

function track(host: BotsHost, launch: Launch) {
  const relay = new Relay(host, []);
  const scheduler = new RoutineScheduler(host, relay, launch);
  running.push(scheduler, relay);
  return { scheduler, relay };
}

async function startScheduler(bots: Bot[], launch: Launch, brokenChat?: string) {
  const host = fakeHost(bots);
  const paseo = fakePaseo(brokenChat);
  host.attach(paseo.api);
  const started = track(host, launch);
  void started.scheduler.stop();
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
});

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
  useTempPaseoHome("paseo-bots-scheduler-");

  it("records runs, posts cards to the results chat, and finishes them when the chat's turn ends", async () => {
    const hook = routine({
      id: "rt-hook",
      name: "Orders",
      schedule: { kind: "webhook" },
      resultsChatId: "results-chat",
    });
    let started = 0;
    const prompts: string[] = [];
    // Created now, so the first tick has no missed run to record.
    const { scheduler, appended, status } = await startScheduler(
      [makeBot({ id: "bot-r", routines: [routine({ createdAt: new Date().toISOString() }), hook] })],
      async (_host, _relay, _bot, { prompt }) => {
        prompts.push(prompt);
        return `run-chat-${++started}`;
      },
    );
    const manual = await scheduler.runNow("bot-r", "rt-1");
    expect(manual.run).toMatchObject({ trigger: "manual", status: "running", agentId: "run-chat-1" });
    // No results chat: nothing is posted.
    expect(appended).toHaveLength(0);

    // While that run's chat is working, the next run is skipped.
    status.set("run-chat-1", "running");
    expect((await scheduler.runNow("bot-r", "rt-1")).run.status).toBe("skipped-busy");

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
    expect(await call.json()).toEqual({ status: "running", chat: "run-chat-2" });
    expect(prompts[1]).toContain("order 42 shipped");
    expect(appended.at(-1)).toMatchObject({
      agentId: "results-chat",
      item: { kind: "routine-run", data: { status: "running", output: null } },
    });

    // The run's turn ends: it's recorded and its card updated in place (same id).
    await scheduler.finished("rt-hook", "run-chat-2", { kind: "completed" }, "Shipped order 42 to Acme.");
    const last = defined(appended.at(-1), "updated card");
    expect(last.item.id).toBe(defined(appended.at(-2), "posted card").item.id);
    expect(last.item.data).toMatchObject({ status: "succeeded", output: "Shipped order 42 to Acme." });
    const { routines } = await scheduler.status();
    expect(routines["rt-hook"]?.runs.map((run) => [run.trigger, run.status])).toEqual([
      ["webhook", "succeeded"],
    ]);
    expect(routines["rt-1"]?.runs.map((run) => run.status)).toEqual(["running", "skipped-busy"]);

    // A rotated URL retires the old one.
    const { url: fresh } = await scheduler.webhookUrl("rt-hook", true);
    expect(fresh).not.toBe(url);
    expect((await fetch(url, { method: "POST" })).status).toBe(404);
  });
});

describe("routine runs", () => {
  useTempPaseoHome("paseo-bots-scheduler-runs-");

  it("posts a card for a run it skipped because it was missed by too long", async () => {
    const missed = routine({
      id: "rt-missed",
      schedule: { kind: "once", at: hoursAgo(13) },
      resultsChatId: "digest-chat",
      createdAt: hoursAgo(14),
    });
    const { scheduler, appended } = await startScheduler(
      [makeBot({ id: "bot-m", routines: [missed] })],
      async () => "never-started",
    );
    await vi.waitFor(() =>
      expect(appended.map((card) => [card.agentId, card.item.data.status])).toEqual([
        ["digest-chat", "skipped-missed"],
      ]),
    );
    const { routines } = await scheduler.status();
    expect(routines["rt-missed"]?.runs.map((run) => run.status)).toEqual(["skipped-missed"]);
  });

  it("keeps running the other routines when one of them fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const due = { schedule: { kind: "interval", minutes: 30 } as const, createdAt: hoursAgo(1) };
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
      async (_host, _relay, _bot, { title }) => `chat-${title}`,
    );
    await vi.waitFor(async () =>
      expect((await scheduler.status()).routines["rt-after"]?.runs.map((run) => run.agentId)).toEqual([
        "chat-After",
      ]),
    );
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('"Broken" (rt-broken)'), expect.any(Error));
  });

  it("reports a run as started when its results chat can't take the card", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const lost = routine({ id: "rt-lost", resultsChatId: "gone-chat", createdAt: new Date().toISOString() });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-l", routines: [lost] })],
      async () => "lost-run-chat",
      "gone-chat",
    );
    const { run } = await scheduler.runNow("bot-l", "rt-lost");
    expect(run).toMatchObject({ status: "running", agentId: "lost-run-chat" });
    expect(errors).toHaveBeenCalledWith("paseo-bots: couldn't post a routine result", expect.any(Error));
  });
});

describe("routine chats that take a while to start", () => {
  useTempPaseoHome("paseo-bots-scheduler-starts-");

  it("records other runs while a routine's chat is still starting, and skips it while it starts", async () => {
    let started: () => void = () => {};
    const slow = new Promise<string>((resolve) => {
      started = () => resolve("slow-chat");
    });
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
      (_host, _relay, _bot, { title }) => (title === "Slow" ? slow : Promise.resolve("quick-chat")),
    );
    const slowRun = scheduler.runNow("bot-q", "rt-slow");
    // Before the fix this waits on the slow chat, which only starts below.
    expect((await scheduler.runNow("bot-q", "rt-quick")).run.agentId).toBe("quick-chat");
    expect((await scheduler.runNow("bot-q", "rt-slow")).run.status).toBe("skipped-busy");
    started();
    expect((await slowRun).run).toMatchObject({ status: "running", agentId: "slow-chat" });
    const { routines } = await scheduler.status();
    expect(routines["rt-slow"]?.runs.map((run) => [run.status, run.agentId])).toEqual([
      ["running", "slow-chat"],
      ["skipped-busy", null],
    ]);
  });

  it("finishes a run whose turn ends before the run is recorded", async () => {
    let finishing: Promise<void> = Promise.resolve();
    const fast = routine({
      id: "rt-fast",
      schedule: { kind: "webhook" },
      resultsChatId: "fast-results",
    });
    const { scheduler, appended } = await startScheduler(
      [makeBot({ id: "bot-f", routines: [fast] })],
      async () => {
        finishing = scheduler.finished(
          "rt-fast",
          "fast-chat",
          { kind: "failed", error: { message: "No credits left." } },
          "",
        );
        return "fast-chat";
      },
    );
    await scheduler.runNow("bot-f", "rt-fast");
    await finishing;
    const { routines } = await scheduler.status();
    expect(routines["rt-fast"]?.runs.map((run) => [run.status, run.error])).toEqual([
      ["failed", "No credits left."],
    ]);
    expect(appended.map((card) => card.item.data.status)).toEqual(["running", "failed"]);
  });
});

describe("the routine scheduler's saved state", () => {
  useTempPaseoHome("paseo-bots-scheduler-state-");

  it("sets a broken routines.json aside instead of overwriting the run history", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = '{"rt-1": {"lastRunAt": "2026-09-2';
    await writeState("routines.json", broken);
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-s", routines: [routine({ createdAt: new Date().toISOString() })] })],
      async () => "chat-1",
    );
    await scheduler.runNow("bot-s", "rt-1");
    expect(await setAside("routines.json")).toEqual([broken]);
    expect((await scheduler.status()).routines["rt-1"]?.runs.map((run) => run.status)).toEqual(["running"]);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("routines.json"), expect.any(SyntaxError));
  });

  it("sets a broken webhooks.json aside instead of overwriting the secrets", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await writeState("webhooks.json", '{"rt-hook": "ab');
    const hook = routine({ id: "rt-hook", schedule: { kind: "webhook" } });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-w", routines: [hook] })],
      async () => "chat-1",
    );
    expect((await scheduler.webhookUrl("rt-hook")).url).toMatch(/\/hooks\/rt-hook\/[a-f0-9]{48}$/);
    expect(await setAside("webhooks.json")).toEqual(['{"rt-hook": "ab']);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("webhooks.json"), expect.any(SyntaxError));
  });

  it("gives two callers asking at once the same saved webhook secret", async () => {
    const hook = routine({ id: "rt-race", schedule: { kind: "webhook" } });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-race", routines: [hook] })],
      async () => "chat-1",
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
      async () => "hook-chat",
    );
    const guess = `http://127.0.0.1:${await relay.start()}/hooks/rt-short/${"a".repeat(48)}`;
    expect((await hook(guess))[0]).toBe(404);
    for (const id of ["rt-short", "rt-num"]) {
      const { url } = await scheduler.webhookUrl(id);
      expect(url).toMatch(new RegExp(`/hooks/${id}/[a-f0-9]{48}$`));
      expect(await hook(url, "event")).toEqual([202, { status: "running", chat: "hook-chat" }]);
    }
  });
});

const fresh = () => new Date().toISOString();
const webhook = (patch: Partial<Routine> = {}) => routine({ schedule: { kind: "webhook" }, ...patch });

function savedRun(id: string, patch: Partial<RoutineRun> = {}): RoutineRun {
  const at = hoursAgo(1);
  return {
    id,
    trigger: "manual",
    scheduledFor: at,
    startedAt: at,
    endedAt: at,
    status: "succeeded",
    agentId: null,
    output: null,
    error: null,
    ...patch,
  };
}

async function runsOf(scheduler: RoutineScheduler, routineId: string) {
  return (await scheduler.status()).routines[routineId]?.runs ?? [];
}

async function hook(url: string, body?: string): Promise<[number, unknown]> {
  const answer = await fetch(url, { method: "POST", body });
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
  useTempPaseoHome("paseo-bots-scheduler-fails-");

  it("fails a run whose chat can't start, says why, and still starts the next one", async () => {
    const failures: unknown[] = [new Error("No model is set up."), "quota exhausted"];
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-x",
          routines: [routine({ id: "rt-x", resultsChatId: "x-results", createdAt: fresh() })],
        }),
      ],
      () => Promise.reject(failures.shift()),
    );
    const first = (await scheduler.runNow("bot-x", "rt-x")).run;
    expect(first).toMatchObject({ status: "failed", agentId: null, error: "No model is set up." });
    expect(first.endedAt).toBe(first.startedAt);
    expect((await scheduler.runNow("bot-x", "rt-x")).run).toMatchObject({
      status: "failed",
      error: "quota exhausted",
    });
    const outcomes = [
      ["failed", "No model is set up."],
      ["failed", "quota exhausted"],
    ];
    expect(appended.map((card) => [card.item.data.status, card.item.data.error])).toEqual(outcomes);
    expect((await runsOf(scheduler, "rt-x")).map((run) => [run.status, run.error])).toEqual(outcomes);
  });

  it("fails runs of bots stored on another host and leaves them and archived bots off the schedule", async () => {
    const due = { schedule: { kind: "interval", minutes: 30 } as const, createdAt: hoursAgo(1) };
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-away",
          hostId: "laptop",
          routines: [routine({ ...due, id: "rt-away", resultsChatId: "away-results" })],
        }),
        makeBot({ id: "bot-old", archived: true, routines: [routine({ ...due, id: "rt-old" })] }),
        makeBot({ id: "bot-here", routines: [routine({ ...due, id: "rt-here" })] }),
      ],
      async (_host, _relay, bot) => `chat-${bot.id}`,
    );
    await vi.waitFor(async () => expect(await runsOf(scheduler, "rt-here")).toHaveLength(1));
    const { routines } = await scheduler.status();
    expect([routines["rt-away"], routines["rt-old"]]).toEqual([undefined, undefined]);
    const { run } = await scheduler.runNow("bot-away", "rt-away");
    expect(run).toMatchObject({
      status: "failed",
      agentId: null,
      error: expect.stringContaining("another host"),
    });
    expect(appended.map((card) => [card.agentId, card.item.data.status])).toEqual([
      ["away-results", "failed"],
    ]);
  });

  it("says when the bot or routine doesn't exist", async () => {
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-n", routines: [routine({ id: "rt-n", createdAt: fresh() })] })],
      async () => "never-started",
    );
    await expect(scheduler.runNow("bot-n", "rt-gone")).rejects.toThrow("Routine not found.");
    await expect(scheduler.runNow("bot-gone", "rt-n")).rejects.toThrow("Routine not found.");
  });
});

describe("routine runs already in progress", () => {
  useTempPaseoHome("paseo-bots-scheduler-busy-");

  it("starts the next run once the last chat is idle or can't be checked", async () => {
    let started = 0;
    const { scheduler, status, unreachable } = await startScheduler(
      [makeBot({ id: "bot-b", routines: [routine({ id: "rt-b", createdAt: fresh() })] })],
      async () => `busy-chat-${++started}`,
    );
    const next = async () => (await scheduler.runNow("bot-b", "rt-b")).run;
    expect((await next()).agentId).toBe("busy-chat-1");
    expect((await next()).agentId).toBe("busy-chat-2");
    status.set("busy-chat-2", "initializing");
    expect((await next()).status).toBe("skipped-busy");
    unreachable.add("busy-chat-2");
    expect((await next()).agentId).toBe("busy-chat-3");
  });

  it("finishes a canceled turn once and ignores turns of other chats", async () => {
    const { scheduler, appended } = await startScheduler(
      [
        makeBot({
          id: "bot-c",
          routines: [routine({ id: "rt-c", resultsChatId: "c-results", createdAt: fresh() })],
        }),
      ],
      async () => "cancel-chat",
    );
    await scheduler.runNow("bot-c", "rt-c");
    await scheduler.finished("rt-c", "stranger-chat", { kind: "completed" }, "Not mine.");
    await scheduler.finished("rt-unknown", "cancel-chat", { kind: "completed" }, "No such routine.");
    await scheduler.finished("rt-c", "cancel-chat", { kind: "canceled", reason: "user" }, "  ");
    await scheduler.finished("rt-c", "cancel-chat", { kind: "completed" }, "Too late.");
    expect((await runsOf(scheduler, "rt-c")).map((run) => [run.status, run.output, run.error])).toEqual([
      ["failed", null, "Stopped before it finished."],
    ]);
    expect((await scheduler.status()).routines["rt-unknown"]).toBeUndefined();
    expect(appended.map((card) => card.item.data.status)).toEqual(["running", "failed"]);
  });

  it("records a run that ends after its routine was deleted, without a card", async () => {
    const { scheduler, appended, host } = await startScheduler(
      [
        makeBot({
          id: "bot-d",
          routines: [routine({ id: "rt-d", resultsChatId: "d-results", createdAt: fresh() })],
        }),
      ],
      async () => "doomed-chat",
    );
    await scheduler.runNow("bot-d", "rt-d");
    defined(defined(await host.values(), "settings").bots[0], "bot").routines = [];
    await scheduler.finished("rt-d", "doomed-chat", { kind: "completed" }, "Done anyway.");
    expect((await runsOf(scheduler, "rt-d")).map((run) => [run.status, run.output])).toEqual([
      ["succeeded", "Done anyway."],
    ]);
    expect(appended.map((card) => card.item.data.status)).toEqual(["running"]);
  });

  it("keeps a routine's last 30 runs", async () => {
    const old = Array.from({ length: 30 }, (_, index) => savedRun(`old-${index}`));
    await writeState("routines.json", JSON.stringify({ "rt-k": { lastRunAt: null, runs: old } }));
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-k", routines: [routine({ id: "rt-k", createdAt: fresh() })] })],
      async () => "kept-chat",
    );
    const { run } = await scheduler.runNow("bot-k", "rt-k");
    const ids = (await runsOf(scheduler, "rt-k")).map((entry) => entry.id);
    expect(ids).toHaveLength(30);
    expect([ids[0], ids.at(-1)]).toEqual(["old-1", run.id]);
  });
});

describe("routine history saved earlier", () => {
  useTempPaseoHome("paseo-bots-scheduler-history-");

  it("reads history saved by older versions", async () => {
    const at = "2026-09-20T09:00:00.000Z";
    const legacy = {
      "rt-failed": { lastRunAt: at, lastStatus: "failed", lastError: "Timed out.", lastAgentId: "old-chat" },
      "rt-missed": { lastRunAt: at, lastStatus: "skipped-missed" },
      "rt-odd": { lastRunAt: at, lastStatus: "something else" },
      "rt-never": { lastRunAt: null },
    };
    await writeState("routines.json", JSON.stringify(legacy));
    const { scheduler } = await startScheduler([], async () => "never-started");
    const { routines } = await scheduler.status();
    expect(routines["rt-failed"]).toEqual({
      lastRunAt: at,
      runs: [
        savedRun("legacy", {
          trigger: "schedule",
          scheduledFor: at,
          startedAt: at,
          endedAt: null,
          status: "failed",
          agentId: "old-chat",
          error: "Timed out.",
        }),
      ],
    });
    const summary = (id: string) => routines[id]?.runs.map((run) => [run.status, run.agentId, run.error]);
    expect(summary("rt-missed")).toEqual([["skipped-missed", null, null]]);
    expect(summary("rt-odd")).toEqual([["succeeded", null, null]]);
    expect(routines["rt-never"]).toEqual({ lastRunAt: null, runs: [] });
  });

  it("shows a run that never finished as failed after 12 hours", async () => {
    const runs = [
      savedRun("lost", { status: "running", startedAt: hoursAgo(13), endedAt: null }),
      savedRun("recent", { status: "running", startedAt: hoursAgo(11), endedAt: null }),
    ];
    await writeState("routines.json", JSON.stringify({ "rt-s": { lastRunAt: null, runs } }));
    const { scheduler } = await startScheduler([], async () => "never-started");
    expect((await runsOf(scheduler, "rt-s")).map((run) => [run.id, run.status, run.error])).toEqual([
      ["lost", "failed", "It never finished."],
      ["recent", "running", null],
    ]);
  });

  it("reads null entries and runs as empty and records the next run over them", async () => {
    const saved = { "rt-null": null, "rt-holes": { lastRunAt: null, runs: [null, savedRun("kept")] } };
    await writeState("routines.json", JSON.stringify(saved));
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-null", routines: [routine({ id: "rt-null", createdAt: fresh() })] })],
      async () => "null-chat",
    );
    expect((await runsOf(scheduler, "rt-holes")).map((run) => run.id)).toEqual(["kept"]);
    expect(await runsOf(scheduler, "rt-null")).toEqual([]);
    await scheduler.runNow("bot-null", "rt-null");
    expect((await runsOf(scheduler, "rt-null")).map((run) => run.agentId)).toEqual(["null-chat"]);
  });
});

describe("routine webhook calls", () => {
  useTempPaseoHome("paseo-bots-scheduler-hooks-");

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
      async () => "never-started",
    );
    const notFound = [404, { error: "not found" }];
    const call = async (routineId: string) => hook((await scheduler.webhookUrl(routineId)).url);
    expect(await call("rt-paused")).toEqual([409, { error: "The routine is paused." }]);
    expect(await call("rt-shelved")).toEqual(notFound);
    expect(await call("rt-timed")).toEqual(notFound);
    expect(await hook((await scheduler.webhookUrl("rt-paused")).url.slice(0, -1))).toEqual(notFound);
    expect(await runsOf(scheduler, "rt-paused")).toEqual([]);
  });

  it("takes ten calls a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-t", routines: [webhook({ id: "rt-many" })] })],
      async () => "many-chat",
    );
    const { url } = await scheduler.webhookUrl("rt-many");
    const answers: number[] = [];
    for (let call = 0; call < 10; call++) answers.push((await hook(url, `event ${call}`))[0]);
    expect(answers).toEqual(Array(10).fill(202));
    expect(await hook(url, "one more")).toEqual([429, { error: "Too many calls this minute." }]);
    vi.setSystemTime(Date.now() + 60_000);
    expect((await hook(url, "next minute"))[0]).toBe(202);
    expect(await runsOf(scheduler, "rt-many")).toHaveLength(11);
  });

  it("answers 413 to a body over 256 KB and hands an empty one over as marked", async () => {
    const prompts: string[] = [];
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-e", routines: [webhook({ id: "rt-empty" })] })],
      async (_host, _relay, _bot, { prompt }) => {
        prompts.push(prompt);
        return "empty-chat";
      },
    );
    const { url } = await scheduler.webhookUrl("rt-empty");
    expect(await declareBody(url, 300 * 1024)).toEqual([
      413,
      JSON.stringify({ error: "Send at most 256 KB." }),
    ]);
    expect(await hook(url)).toEqual([202, { status: "running", chat: "empty-chat" }]);
    expect(prompts).toEqual([expect.stringContaining("Content type: unknown\n\n(empty body)\n")]);
  });

  it("answers 500 with the reason when a webhook's chat can't start", async () => {
    const { scheduler } = await startScheduler(
      [makeBot({ id: "bot-500", routines: [webhook({ id: "rt-500" })] })],
      () => Promise.reject(new Error("The bot has no provider.")),
    );
    const { url } = await scheduler.webhookUrl("rt-500");
    expect(await hook(url, "event")).toEqual([500, { status: "failed", error: "The bot has no provider." }]);
  });
});

describe("overlapping routine webhook calls", () => {
  useTempPaseoHome("paseo-bots-scheduler-overlap-");

  it("lets three webhook runs be unfinished at once while their cards post", async () => {
    let started = 0;
    let posted: () => void = () => {};
    const { scheduler, status, posting } = await startScheduler(
      [makeBot({ id: "bot-p", routines: [webhook({ id: "rt-p", resultsChatId: "p-results" })] })],
      async () => {
        const chat = `p-chat-${++started}`;
        status.set(chat, "running");
        return chat;
      },
    );
    posting.until = new Promise((resolve) => {
      posted = resolve;
    });
    const { url } = await scheduler.webhookUrl("rt-p");
    const calls: Promise<[number, unknown]>[] = [];
    for (const count of [1, 2, 3]) {
      calls.push(hook(url, `event ${count}`));
      await vi.waitFor(() => expect(started).toBe(count));
    }
    expect(await hook(url, "event 4")).toEqual([429, { status: "skipped-busy" }]);
    posted();
    expect(await Promise.all(calls)).toEqual(
      [1, 2, 3].map((count) => [202, { status: "running", chat: `p-chat-${count}` }]),
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
  const { scheduler } = track(host, async (_host, _relay, _bot, { title }) => {
    launched.push(title);
    return `clock-chat-${launched.length}`;
  });
  return { host, scheduler, launched };
}

describe("the routine clock", () => {
  useTempPaseoHome("paseo-bots-scheduler-clock-");

  it("catches up a run missed while Paseo was closed, then ticks every 30 seconds until stopped", async () => {
    const { host, scheduler, launched } = catchUpThenTick();
    expect((await scheduler.status()).scheduler).toBe(false);
    host.attach(fakePaseo().api);
    await vi.waitFor(() => expect(launched).toEqual(["Daily"]));
    expect((await runsOf(scheduler, "rt-daily")).map((run) => [run.trigger, run.scheduledFor])).toEqual([
      ["schedule", local(28, 9).toISOString()],
    ]);
    vi.advanceTimersByTime(60_000);
    await vi.waitFor(() => expect(launched).toEqual(["Daily", "Minutely"]));
    host.attach(fakePaseo().api);
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.stop();
    await scheduler.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect((await scheduler.status()).scheduler).toBe(true);
  });

  it("waits for settings to load and recovers from a tick that fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
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
      async () => ({ status: "loading" }),
      async () => {
        throw new Error("Settings are locked.");
      },
    ];
    const ready = async () => ({ status: "ready", values, revision: "1" });
    const host = new BotsHost({ read: () => (reads.shift() ?? ready)() } as never);
    const launched: string[] = [];
    track(host, async (_host, _relay, _bot, { title }) => {
      launched.push(title);
      return "flaky-chat";
    });
    host.attach(fakePaseo().api);
    await vi.waitFor(() => {
      vi.advanceTimersByTime(30_000);
      expect(launched).toEqual(["Inbox check"]);
    });
    expect(errors).toHaveBeenCalledWith("paseo-bots: routine tick failed", expect.any(Error));
  });

  it("finishes the tick under way before it says it stopped", async () => {
    const events = new EventEmitter();
    const launching = once(events, "launch");
    const due = routine({ id: "rt-z", schedule: { kind: "interval", minutes: 30 }, createdAt: hoursAgo(1) });
    const { scheduler } = await startScheduler([makeBot({ id: "bot-z", routines: [due] })], async () => {
      events.emit("launch");
      const [chat] = await once(events, "started");
      return chat as string;
    });
    await launching;
    const stopped = scheduler.stop();
    events.emit("started", "chat-z");
    await stopped;
    expect((await runsOf(scheduler, "rt-z")).map((run) => run.agentId)).toEqual(["chat-z"]);
  });
});
