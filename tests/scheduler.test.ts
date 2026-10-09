import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import type { startChat } from "../server/chats";
import { Relay } from "../server/relay";
import { RoutineScheduler, runPrompt } from "../server/scheduler";
import type { Bot, Routine } from "../shared/bot";
import { scheduleFrom, upcomingRuns } from "../shared/routines";
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

async function startScheduler(bots: Bot[], launch: Launch, brokenChat?: string) {
  const host = fakeHost(bots);
  const paseo = fakePaseo(brokenChat);
  host.attach(paseo.api);
  const relay = new Relay(host, []);
  const scheduler = new RoutineScheduler(host, relay, launch);
  scheduler.stop();
  return { scheduler, relay, host, ...paseo };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

async function writeState(name: string, text: string): Promise<void> {
  await mkdir(pluginDataPath(), { recursive: true });
  await writeFile(join(pluginDataPath(), name), text);
}

async function setAside(name: string): Promise<string[]> {
  const files = (await readdir(pluginDataPath())).filter((file) => file.startsWith(`${name}.corrupt-`));
  return Promise.all(files.map((file) => readFile(join(pluginDataPath(), file), "utf8")));
}

afterEach(() => {
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
    const { scheduler, relay, appended, status } = await startScheduler(
      [makeBot({ id: "bot-r", routines: [routine({ createdAt: new Date().toISOString() }), hook] })],
      async (_host, _relay, _bot, { prompt }) => {
        prompts.push(prompt);
        return `run-chat-${++started}`;
      },
    );
    try {
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
    } finally {
      relay.stop();
    }
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
    const { scheduler, relay } = await startScheduler(
      [makeBot({ id: "bot-w", routines: [hook] })],
      async () => "chat-1",
    );
    try {
      expect((await scheduler.webhookUrl("rt-hook")).url).toMatch(/\/hooks\/rt-hook\/[a-f0-9]{48}$/);
      expect(await setAside("webhooks.json")).toEqual(['{"rt-hook": "ab']);
      expect(errors).toHaveBeenCalledWith(expect.stringContaining("webhooks.json"), expect.any(SyntaxError));
    } finally {
      relay.stop();
    }
  });

  it("gives two callers asking at once the same saved webhook secret", async () => {
    const hook = routine({ id: "rt-race", schedule: { kind: "webhook" } });
    const { scheduler, relay } = await startScheduler(
      [makeBot({ id: "bot-race", routines: [hook] })],
      async () => "chat-1",
    );
    try {
      const [first, second] = await Promise.all([
        scheduler.webhookUrl("rt-race"),
        scheduler.webhookUrl("rt-race"),
      ]);
      expect(second.url).toBe(first.url);
      const saved = JSON.parse(await readFile(join(pluginDataPath(), "webhooks.json"), "utf8"));
      expect(first.url.endsWith(`/${saved["rt-race"]}`)).toBe(true);
    } finally {
      relay.stop();
    }
  });
});

const webhook = (patch: Partial<Routine> = {}) => routine({ schedule: { kind: "webhook" }, ...patch });
async function hook(url: string, body?: string): Promise<[number, unknown]> {
  const answer = await fetch(url, { method: "POST", body });
  return [answer.status, await answer.json()];
}
describe("overlapping routine webhook calls", () => {
  useTempPaseoHome("paseo-bots-scheduler-overlap-");

  it("lets three webhook runs be unfinished at once while their cards post", async () => {
    let started = 0;
    let posted: () => void = () => {};
    const { scheduler, relay, status, posting } = await startScheduler(
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
    try {
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
    } finally {
      relay.stop();
    }
  });
});
