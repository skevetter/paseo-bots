import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { MEMORY_TOOLS } from "../server/control/tools/memory";
import { appendDailyLog } from "../server/memory";
import { startControl } from "./control-helpers";
import { makeBot, useTempPaseoHome } from "./helpers";

const running: { stop(): Promise<void> }[] = [];

async function control() {
  const started = await startControl(MEMORY_TOOLS, { bots: [makeBot({ id: "bot-m", name: "Memo" })] });
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

describe("memory control tools", () => {
  useTempPaseoHome("paseo-bots-control-memory-");

  it("writes, reads, journals and undoes memory edits", async () => {
    const { call } = await control();
    expect((await call("memory_write", { bot: "Memo", name: "MEMORY.md", text: "first" })).isError).toBe(
      false,
    );
    await call("memory_write", { bot: "Memo", name: "MEMORY.md", text: "second" });
    expect((await call("memory_read", { bot: "Memo", name: "MEMORY.md" })).data).toMatchObject({
      text: "second",
    });

    const listed = await call("memory_list", { bot: "Memo" });
    expect(listed.data).toMatchObject({ files: [{ name: "MEMORY.md", lines: 1 }], injectedLines: 1 });

    const journal = await call("memory_journal", { bot: "Memo" });
    const { entries } = z
      .object({
        entries: z.array(
          z.object({ id: z.string(), kind: z.string(), via: z.string(), canUndo: z.boolean() }),
        ),
      })
      .parse(journal.data);
    const edit = entries.find((entry) => entry.kind === "edited");
    expect(edit).toMatchObject({ via: "app", canUndo: true });
    expect(entries.some((entry) => entry.kind === "created")).toBe(true);

    await call("memory_undo", { bot: "Memo", id: edit?.id });
    expect((await call("memory_read", { bot: "Memo", name: "MEMORY.md" })).data).toMatchObject({
      text: "first",
    });
  });

  it("deletes a topic file only with confirm", async () => {
    const { call } = await control();
    await call("memory_write", { bot: "bot-m", name: "people.md", text: "Ana" });
    expect((await call("memory_delete", { bot: "Memo", name: "people.md" })).isError).toBe(true);
    expect((await call("memory_read", { bot: "Memo", name: "people.md" })).data).toMatchObject({
      text: "Ana",
    });
    await call("memory_delete", { bot: "Memo", name: "people.md", confirm: true });
    expect((await call("memory_read", { bot: "Memo", name: "people.md" })).data).toMatchObject({ text: "" });
  });

  it("rejects file names outside the memory folder", async () => {
    const { call } = await control();
    expect((await call("memory_read", { bot: "Memo", name: "../state.md" })).isError).toBe(true);
  });

  it("lists, reads and deletes daily log days", async () => {
    const { call } = await control();
    await appendDailyLog("bot-m", "- 09:05 · Did a thing.", new Date(2026, 8, 27, 9, 5));
    await appendDailyLog("bot-m", "- 10:00 · Another.", new Date(2026, 8, 27, 10, 0));

    const days = await call("memory_log", { bot: "Memo" });
    expect(days.data).toMatchObject({ days: [{ day: "2026-09-27", lines: 2 }], text: null });
    const day = await call("memory_log", { bot: "Memo", day: "2026-09-27" });
    expect(z.object({ text: z.string() }).parse(day.data).text).toContain("Did a thing.");
    expect((await call("memory_log", { bot: "Memo", day: "27-09-2026" })).isError).toBe(true);

    expect((await call("memory_log_delete", { bot: "Memo", day: "2026-09-27" })).isError).toBe(true);
    await call("memory_log_delete", { bot: "Memo", day: "2026-09-27", confirm: true });
    expect((await call("memory_log", { bot: "Memo" })).data).toMatchObject({ days: [] });
  });
});
