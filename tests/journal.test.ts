import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { type JournalEntry, MemoryJournal } from "../server/journal";
import { memoryFilePath } from "../server/memory";
import { defined, useTempPaseoHome } from "./helpers";

const A = { id: "chat-a", title: "Chat A" };
const B = { id: "chat-b", title: "Chat B" };

async function memoryFile(botId: string, text: string): Promise<string> {
  const path = memoryFilePath(botId, "MEMORY.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, text);
  return path;
}

const summary = (entries: JournalEntry[]) =>
  entries.map((entry) => [entry.file, entry.actor, entry.via, entry.chats.map((chat) => chat.id)]);

describe("journal attribution", () => {
  useTempPaseoHome("paseo-bots-journal-");

  it("does not hand one chat's edit to the person when another chat starts mid-turn", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-overlap", "# Memory\n");
    await journal.begin("bot-overlap", A, "t1");
    await writeFile(main, "# Memory\n- from A\n");
    await journal.begin("bot-overlap", B, "t2");
    expect(await journal.list("bot-overlap")).toEqual([]);

    await journal.end("bot-overlap", A, "t1");
    await journal.end("bot-overlap", B, "t2");

    const entries = await journal.list("bot-overlap");
    expect(summary(entries)).toEqual([["MEMORY.md", "ambiguous", "chat", ["chat-a", "chat-b"]]]);
    expect(entries[0]).toMatchObject({ chat: null, added: 1 });
  });

  it("settles later changes on whoever is still running once an overlapping chat has ended", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-tail", "# Memory\n");
    await journal.begin("bot-tail", A, "t1");
    await journal.begin("bot-tail", B, "t2");
    await writeFile(main, "# Memory\n- early\n");
    await journal.end("bot-tail", A, "t1");
    await writeFile(main, "# Memory\n- early\n- late\n");
    await journal.end("bot-tail", B, "t2");

    const entries = await journal.list("bot-tail");
    expect(summary(entries)).toEqual([
      ["MEMORY.md", "bot", "chat", []],
      ["MEMORY.md", "ambiguous", "chat", ["chat-a", "chat-b"]],
    ]);
    expect(entries[0]?.chat).toEqual(B);
  });

  it("names the chat again once turns no longer overlap", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-serial", "# Memory\n");
    await journal.begin("bot-serial", A, "t1");
    await writeFile(main, "# Memory\n- one\n");
    await journal.end("bot-serial", A, "t1");
    await journal.begin("bot-serial", B, "t2");
    await writeFile(main, "# Memory\n- one\n- two\n");
    await journal.end("bot-serial", B, "t2");

    expect((await journal.list("bot-serial")).map((entry) => [entry.actor, entry.chat?.id])).toEqual([
      ["bot", "chat-b"],
      ["bot", "chat-a"],
    ]);
  });

  it("keeps an edit made while no chat runs as the person's, even with a chat running afterwards", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-disk", "# Memory\n");
    await journal.begin("bot-disk", A, "t1");
    await journal.end("bot-disk", A, "t1");
    await writeFile(main, "# Memory\n- by hand\n");
    await journal.begin("bot-disk", B, "t2");

    expect(summary(await journal.list("bot-disk"))).toEqual([["MEMORY.md", "you", "disk", []]]);
  });

  it("ignores the end of a turn the chat has since replaced", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-stale", "# Memory\n");
    await journal.begin("bot-stale", A, "t1");
    await journal.begin("bot-stale", A, "t2");
    await writeFile(main, "# Memory\n- during t2\n");
    await journal.end("bot-stale", A, "t1");
    expect(await journal.list("bot-stale")).toEqual([]);

    await journal.end("bot-stale", A, "t2");
    expect(summary(await journal.list("bot-stale"))).toEqual([["MEMORY.md", "bot", "chat", []]]);
  });
});

describe("journal long-running turns", () => {
  useTempPaseoHome("paseo-bots-journal-long-turn-");
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps long-running chats ambiguous until their end is observed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-ttl", "# Memory\n");
    await journal.begin("bot-ttl", A, "lost");

    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    await journal.begin("bot-ttl", B, "t2");
    await writeFile(main, "# Memory\n- from B\n");
    await journal.end("bot-ttl", B, "t2");
    expect((await journal.list("bot-ttl"))[0]).toMatchObject({ actor: "ambiguous", chat: null });

    vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
    await journal.begin("bot-ttl", B, "t3");
    await writeFile(main, "# Memory\n- again\n");
    await journal.end("bot-ttl", B, "t3");
    expect((await journal.list("bot-ttl"))[0]).toMatchObject({ actor: "ambiguous", chat: null });
    await journal.end("bot-ttl", A, "lost");
    await journal.begin("bot-ttl", B, "t4");
    await writeFile(main, "# Memory\n- after A ended\n");
    await journal.end("bot-ttl", B, "t4");
    expect((await journal.list("bot-ttl"))[0]).toMatchObject({ actor: "bot", chat: B });
  });
});

describe("journal undo", () => {
  useTempPaseoHome("paseo-bots-journal-undo-");

  it("rejects undoing a change after a later write, and allows it once that write is undone", async () => {
    const journal = new MemoryJournal();
    await journal.write("bot-stale", "MEMORY.md", "v1\n");
    await journal.write("bot-stale", "MEMORY.md", "v2\n");
    await journal.write("bot-stale", "MEMORY.md", "v3\n");
    const [v3, v2] = await journal.list("bot-stale");

    await expect(journal.undo("bot-stale", defined(v2, "v2").id)).rejects.toThrow(
      "MEMORY.md has changed since that change was made",
    );
    expect(await readFile(memoryFilePath("bot-stale", "MEMORY.md"), "utf8")).toBe("v3\n");

    await journal.undo("bot-stale", defined(v3, "v3").id);
    await journal.undo("bot-stale", defined(v2, "v2").id);
    expect(await readFile(memoryFilePath("bot-stale", "MEMORY.md"), "utf8")).toBe("v1\n");
  });

  it("rejects undoing a bot's edit when the file was edited outside the app afterwards", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-ext", "# Memory\n");
    await journal.begin("bot-ext", A, "t1");
    await writeFile(main, "# Memory\n- bot note\n");
    await journal.end("bot-ext", A, "t1");
    const botEdit = defined((await journal.list("bot-ext"))[0], "bot edit");

    await writeFile(main, "# Memory\n- bot note\n- my own note\n");
    await expect(journal.undo("bot-ext", botEdit.id)).rejects.toThrow("has changed");
    expect(await readFile(main, "utf8")).toBe("# Memory\n- bot note\n- my own note\n");

    // Once the outside edit is journaled, undoing the older change still can't clobber it.
    await journal.begin("bot-ext", B, "t2");
    await expect(journal.undo("bot-ext", botEdit.id)).rejects.toThrow("has changed");
    expect(await readFile(main, "utf8")).toBe("# Memory\n- bot note\n- my own note\n");
  });

  it("refuses to undo a deletion once the file exists again", async () => {
    const journal = new MemoryJournal();
    await journal.write("bot-del", "people.md", "Ana\n");
    await journal.write("bot-del", "people.md", null);
    const deletion = defined((await journal.list("bot-del"))[0], "deletion");
    await journal.write("bot-del", "people.md", "Someone new\n");

    await expect(journal.undo("bot-del", deletion.id)).rejects.toThrow("has changed");
    expect(await readFile(memoryFilePath("bot-del", "people.md"), "utf8")).toBe("Someone new\n");
  });

  it("can't undo entries recorded before undo checked the file, and says why", async () => {
    const journal = new MemoryJournal();
    const main = await memoryFile("bot-old", "# Memory\n- new\n");
    const legacy = {
      id: "j-0123456789",
      at: "2026-10-01T00:00:00.000Z",
      file: "MEMORY.md",
      actor: "bot",
      via: "chat",
      chat: { id: "chat-a", title: "Old" },
      kind: "edited",
      before: "# Memory\n",
      diff: "",
      added: 1,
      removed: 0,
    };
    await mkdir(join(pluginDataPath(), "journal"), { recursive: true });
    await writeFile(join(pluginDataPath(), "journal", "bot-old.ndjson"), `${JSON.stringify(legacy)}\n`);

    expect((await journal.rows("bot-old"))[0]).toMatchObject({
      id: legacy.id,
      chats: [],
      undoBlocked: "unverified",
    });
    expect((await journal.rows("bot-old"))[0]).not.toHaveProperty("afterRevision");
    await expect(journal.undo("bot-old", legacy.id)).rejects.toThrow("before undo could check");
    expect(await readFile(main, "utf8")).toBe("# Memory\n- new\n");
  });
});
