import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { redactSecrets } from "../shared/activity";
import { lineDiff } from "../shared/diff";
import type { JournalRow } from "../shared/rpc";
import { pluginDataPath } from "./bot-home";
import { readParsed, writeAtomic } from "./files";
import { MAIN_MEMORY, memoryFilePath, memoryFolder } from "./memory";

// Bots edit their memory with their own file tools, so changes are found by comparing the files when
// a turn starts and ends. The journal lives outside the bots' folders so a bot can't rewrite its own history.

const KEEP = 200;
const MAX_BEFORE_BYTES = 512 * 1024;
// A turn whose end event never arrived would otherwise keep every later change of that bot ambiguous.
const ACTIVE_TURN_TTL_MS = 6 * 60 * 60 * 1000;

type Chat = { id: string; title: string };

export interface JournalEntry {
  id: string;
  at: string;
  /** "MEMORY.md" or a topic file's name, as the memory RPCs name them. */
  file: string;
  /** "ambiguous": chats overlapped, so it can't be told which of `chats` (or the person) made the change. */
  actor: "bot" | "you" | "ambiguous";
  via: "chat" | "app" | "disk" | "undo";
  chat: Chat | null;
  /** The chats that were running when an ambiguous change was found; empty otherwise. */
  chats: Chat[];
  kind: "created" | "edited" | "deleted";
  /** The text before the change; null for a new file or one too large to keep. */
  before: string | null;
  diff: string;
  added: number;
  removed: number;
  /** What the file held after the change, see `revisionOf`. Entries from before undo checks have none. */
  afterRevision?: string;
}

type Who = Pick<JournalEntry, "actor" | "via" | "chat" | "chats">;

interface ActiveTurn {
  turnId: string | null;
  since: number;
}

/** One bot's running chats and what the files held when they were last compared. */
interface Watch {
  seen: Snapshot | null;
  active: Map<string, ActiveTurn>;
  /** The chats that were running at some point since `seen` was taken. */
  window: Map<string, string>;
}

type Snapshot = Map<string, string>;

function journalPath(botId: string): string {
  return join(pluginDataPath(), "journal", `${botId}.ndjson`);
}

/** A hash of the text, or "absent" for a missing file, so a revision says what a file held without keeping it. */
export function revisionOf(text: string | null): string {
  return text === null ? "absent" : createHash("sha256").update(text).digest("hex");
}

function parseJournal(text: string): JournalEntry[] {
  const lines = text.split("\n").filter((line) => line.trim());
  const entries: JournalEntry[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as Omit<JournalEntry, "chats"> & { chats?: Chat[] };
      entries.push({ ...entry, chats: entry.chats ?? [] });
    } catch {
      // A torn line from a crash; skip it.
    }
  }
  if (lines.length > 0 && entries.length === 0) throw new Error("The journal has no readable entries");
  return entries;
}

async function snapshot(botId: string): Promise<Snapshot> {
  const files: Snapshot = new Map();
  const main = await readFile(memoryFilePath(botId, MAIN_MEMORY), "utf8").catch(() => null);
  if (main !== null) files.set(MAIN_MEMORY, main);
  const names = await readdir(join(memoryFolder(botId), "memory")).catch(() => [] as string[]);
  for (const name of names.filter((entry) => entry.endsWith(".md")).sort()) {
    const text = await readFile(memoryFilePath(botId, name), "utf8").catch(() => null);
    if (text !== null) files.set(name, text);
  }
  return files;
}

type UndoBlock = "too-large" | "unverified";

const UNDO_BLOCKED: Record<UndoBlock, string> = {
  "too-large": "This change was too large to keep a copy of.",
  unverified: "This change was recorded before undo could check the file, so it can't be undone safely.",
};

function undoBlockOf({ kind, before, afterRevision }: JournalEntry): UndoBlock | null {
  if (kind !== "created" && before === null) return "too-large";
  return afterRevision === undefined ? "unverified" : null;
}

/** What undoing `entry` writes, and the revision the file must still have for that to be safe. */
function undoPlan(entry: JournalEntry | undefined): {
  file: string;
  restore: string | null;
  expected: string;
} {
  if (!entry) throw new Error("That change is no longer in the journal.");
  const blocked = undoBlockOf(entry);
  if (blocked || entry.afterRevision === undefined) throw new Error(UNDO_BLOCKED[blocked ?? "unverified"]);
  // Undoing a new topic file deletes it; MEMORY.md is emptied instead.
  const restore = entry.kind === "created" ? (entry.file === MAIN_MEMORY ? "" : null) : entry.before;
  return { file: entry.file, restore, expected: entry.afterRevision };
}

export class MemoryJournal {
  private readonly watches = new Map<string, Watch>();
  private readonly queues = new Map<string, Promise<unknown>>();

  private serial<T>(botId: string, work: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(botId) ?? Promise.resolve()).then(work);
    this.queues.set(
      botId,
      next.catch(() => {}),
    );
    return next;
  }

  private watch(botId: string): Watch {
    let watch = this.watches.get(botId);
    if (!watch) {
      watch = { seen: null, active: new Map(), window: new Map() };
      this.watches.set(botId, watch);
    }
    for (const [agentId, turn] of watch.active)
      if (Date.now() - turn.since > ACTIVE_TURN_TTL_MS) watch.active.delete(agentId);
    return watch;
  }

  /**
   * Changes since the last look were made outside the app, unless a chat was already running: then the
   * files are left unread, so what changed is settled when a running chat ends.
   */
  begin(botId: string, chat: Chat, turnId: string | null): Promise<void> {
    return this.serial(botId, async () => {
      const watch = this.watch(botId);
      if (watch.active.size === 0) {
        const current = await snapshot(botId);
        if (watch.seen)
          await this.record(botId, watch.seen, current, { actor: "you", via: "disk", chat: null, chats: [] });
        watch.seen = current;
        watch.window.clear();
      }
      watch.active.set(chat.id, { turnId, since: Date.now() });
      watch.window.set(chat.id, chat.title);
    });
  }

  /**
   * Changes since the last look were the bot's doing in this chat, unless another chat ran in the same
   * span: then they can't be told apart from each other, or from an edit by the person. An end for a turn
   * the chat has since replaced with a newer one is ignored; the newer turn's end settles it.
   */
  end(botId: string, chat: Chat, turnId: string | null): Promise<void> {
    return this.serial(botId, async () => {
      const watch = this.watch(botId);
      const running = watch.active.get(chat.id)?.turnId;
      if (running && turnId && running !== turnId) return;
      watch.window.set(chat.id, chat.title);
      const current = await snapshot(botId);
      // After a restart there's nothing to compare with until the next turn.
      if (watch.seen) {
        const chats = [...watch.window].map(([id, title]) => ({ id, title }));
        const who: Who =
          chats.length === 1
            ? { actor: "bot", via: "chat", chat, chats: [] }
            : { actor: "ambiguous", via: "chat", chat: null, chats };
        await this.record(botId, watch.seen, current, who);
      }
      watch.seen = current;
      watch.active.delete(chat.id);
      watch.window = new Map([...watch.active.keys()].map((id) => [id, watch.window.get(id) ?? ""]));
    });
  }

  /** `text` null deletes the file. */
  write(botId: string, file: string, text: string | null): Promise<void> {
    return this.serial(botId, () => this.apply(botId, file, text, { via: "app" }));
  }

  /** For an undo, the file must still hold the revision the undone change left, or nothing is written. */
  private async apply(
    botId: string,
    file: string,
    text: string | null,
    how: { via: "app" } | { via: "undo"; expected: string },
  ): Promise<void> {
    const path = memoryFilePath(botId, file);
    const before = await readFile(path, "utf8").catch(() => null);
    if (how.via === "undo" && revisionOf(before) !== how.expected)
      throw new Error(
        `${file} has changed since that change was made, so undoing it would overwrite newer text. Open the file and edit it instead.`,
      );
    if (text === null) await rm(path, { force: true });
    else await writeAtomic(path, text);
    await this.append(
      botId,
      { file, before, after: text },
      { actor: "you", via: how.via, chat: null, chats: [] },
    );
    const seen = this.watches.get(botId)?.seen;
    if (seen) {
      if (text === null) seen.delete(file);
      else seen.set(file, text);
    }
  }

  async list(botId: string, limit = 50): Promise<JournalEntry[]> {
    return (await this.load(botId)).reverse().slice(0, limit);
  }

  /** Without the copies kept for undo, which only say whether it can be undone and, if not, why. */
  async rows(botId: string): Promise<JournalRow[]> {
    return (await this.list(botId)).map((entry) => {
      const { before, afterRevision, ...row } = entry;
      return { ...row, undoBlocked: undoBlockOf(entry) };
    });
  }

  undo(botId: string, id: string): Promise<void> {
    return this.serial(botId, async () => {
      const entry = (await this.load(botId)).find((candidate) => candidate.id === id);
      const { file, restore, expected } = undoPlan(entry);
      await this.apply(botId, file, restore, { via: "undo", expected });
    });
  }

  private async record(botId: string, previous: Snapshot, current: Snapshot, who: Who): Promise<void> {
    for (const file of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.get(file) ?? null;
      const after = current.get(file) ?? null;
      if (before !== after) await this.append(botId, { file, before, after }, who);
    }
  }

  private async append(
    botId: string,
    { file, before, after }: { file: string; before: string | null; after: string | null },
    who: Who,
  ): Promise<void> {
    if (before === after) return;
    const { diff, added, removed } = lineDiff(redactSecrets(before ?? ""), redactSecrets(after ?? ""));
    const entry: JournalEntry = {
      id: `j-${randomBytes(5).toString("hex")}`,
      at: new Date().toISOString(),
      file,
      ...who,
      kind: before === null ? "created" : after === null ? "deleted" : "edited",
      before: before !== null && Buffer.byteLength(before, "utf8") <= MAX_BEFORE_BYTES ? before : null,
      diff,
      added,
      removed,
      afterRevision: revisionOf(after),
    };
    const entries = [...(await this.load(botId)), entry].slice(-KEEP);
    const text = `${entries.map((item) => JSON.stringify(item)).join("\n")}\n`;
    await writeAtomic(journalPath(botId), text, 0o600);
  }

  private async load(botId: string): Promise<JournalEntry[]> {
    return (await readParsed(journalPath(botId), parseJournal)) ?? [];
  }
}
