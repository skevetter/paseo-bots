import { afterEach, describe, expect, it } from "vitest";
import { ROUTINE_TOOLS } from "../server/control/tools/routines";
import type { PaseoApi } from "../server/paseo";
import { RoutineScheduler } from "../server/scheduler";
import { startControl } from "./control-helpers";
import { makeBot, useTempPaseoHome } from "./helpers";

const running: { stop(): Promise<void> }[] = [];

async function control() {
  const started = await startControl(ROUTINE_TOOLS, { bots: [makeBot({ id: "bot-a", name: "Inbox" })] });
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

const daily = { type: "daily", time: "09:30", weekdays: [1, 2, 3, 4, 5] };

describe("routine control tools", () => {
  useTempPaseoHome("paseo-bots-control-routines-");

  it("creates, lists, updates, pauses and deletes routines", async () => {
    const { call, store } = await control();
    const routines = async () => (await store.read()).values.bots[0]?.routines ?? [];
    const created = await call("routines_create", {
      bot: "Inbox",
      name: "Morning",
      instructions: "Sort the inbox.",
      schedule: daily,
      results_chat_id: "chat-9",
    });
    expect(created.isError).toBe(false);
    const saved = (await routines())[0];
    expect(saved).toMatchObject({ name: "Morning", prompt: "Sort the inbox.", resultsChatId: "chat-9" });
    expect(saved?.schedule).toEqual({ kind: "daily", time: "09:30", weekdays: [1, 2, 3, 4, 5] });

    const listed = await call("routines_list", { bot: "bot-a" });
    const [entry] = listed.data.routines as { enabled: boolean; nextRun: string; schedule: string }[];
    expect(entry?.enabled).toBe(true);
    expect([1, 2, 3, 4, 5]).toContain(new Date(entry?.nextRun ?? "").getDay());
    expect(listed.text).toContain(entry?.schedule);

    await call("routines_update", { bot: "Inbox", routine: "Morning", name: "Early", results_chat_id: null });
    expect((await routines())[0]).toMatchObject({ name: "Early", resultsChatId: null });

    await call("routines_disable", { bot: "Inbox", routine: "Early" });
    expect((await routines())[0]?.enabled).toBe(false);
    const paused = await call("routines_list", {});
    expect((paused.data.routines as { nextRun: null }[])[0]?.nextRun).toBeNull();
    await call("routines_enable", { bot: "Inbox", routine: "Early" });
    expect((await routines())[0]?.enabled).toBe(true);

    expect((await call("routines_delete", { bot: "Inbox", routine: "Early" })).isError).toBe(true);
    expect(await routines()).toHaveLength(1);
    await call("routines_delete", { bot: "Inbox", routine: "Early", confirm: true });
    expect(await routines()).toEqual([]);
  });

  it("gives a webhook routine its URL and rotates it", async () => {
    const { call } = await control();
    await call("routines_create", {
      bot: "Inbox",
      name: "Hook",
      instructions: "Handle it.",
      schedule: { type: "webhook" },
    });
    await call("routines_create", { bot: "Inbox", name: "Timed", instructions: "Go.", schedule: daily });
    const first = await call("routines_webhook", { bot: "Inbox", routine: "Hook" });
    expect(first.data.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/hooks\//);
    expect((await call("routines_webhook", { bot: "Inbox", routine: "Hook" })).data.url).toBe(first.data.url);
    const rotated = await call("routines_webhook", { bot: "Inbox", routine: "Hook", rotate: true });
    expect(rotated.data.url).not.toBe(first.data.url);
    const timed = await call("routines_webhook", { bot: "Inbox", routine: "Timed" });
    expect(timed.isError).toBe(true);
  });

  it("runs a routine only once Paseo is attached, then reports it", async () => {
    const { call, context } = await control();
    await call("routines_create", { bot: "Inbox", name: "Morning", instructions: "Go.", schedule: daily });
    const detached = await call("routines_run_now", { bot: "Inbox", routine: "Morning" });
    expect(detached.isError).toBe(true);
    expect(detached.text).toContain("Open Paseo once");

    const launched: string[] = [];
    const original = context.scheduler;
    context.scheduler = new RoutineScheduler(
      context.host,
      context.relay,
      async (_host, _relay, _bot, input) => {
        launched.push(input.title);
        return "agent-1";
      },
    );
    context.host.attach({
      agents: { ref: () => ({ refresh: async () => ({ agent: { status: "idle", archivedAt: null } }) }) },
    } as unknown as PaseoApi);
    await Promise.all([original.stop(), context.scheduler.stop()]);

    const ran = await call("routines_run_now", { bot: "Inbox", routine: "Morning" });
    expect(ran.isError).toBe(false);
    expect(launched).toEqual(["Morning"]);
    const run = ran.data.run as { id: string; trigger: string };
    expect(run.trigger).toBe("manual");

    const status = await call("routines_status");
    expect(status.data.scheduler).toBe(true);
    const routines = status.data.routines as Record<string, { lastRun: { id: string } }>;
    expect(Object.values(routines)[0]?.lastRun.id).toBe(run.id);

    await call("routines_run_now", { bot: "Inbox", routine: "Morning" });
    const history = await call("routines_history", { bot: "Inbox", routine: "Morning" });
    const runs = history.data.runs as { id: string }[];
    expect(runs).toHaveLength(2);
    expect(runs[1]?.id).toBe(run.id);
  });
});
