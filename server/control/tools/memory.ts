import { z } from "zod";
import { JOURNAL_ID, LOG_DAY, MEMORY_FILE_NAME } from "../../../shared/rpc";
import { deleteLogDay, listLogDays, listMemory, readLogDay, readMemory } from "../../memory";
import { BotRef, botByRef, Confirm, type ControlTool, defineControlTool, result } from "../tool";

const FileName = z
  .string()
  .regex(MEMORY_FILE_NAME)
  .describe('"MEMORY.md" (injected into every chat) or a topic file such as "people.md".');
const LogDay = z.string().regex(LOG_DAY).describe("A day as YYYY-MM-DD.");

const memoryList = defineControlTool({
  name: "memory_list",
  description: "List a bot's memory files and how much of MEMORY.md is injected into chats.",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot }, context) {
    const { id } = await botByRef(context, bot);
    const memory = await listMemory(id);
    const names = memory.files.map((file) => `${file.name} (${file.lines} lines)`).join(", ");
    return result(
      `${names}. Injected: ${memory.injectedLines} lines, ${memory.injectedBytes} bytes.`,
      memory,
    );
  },
});

const memoryRead = defineControlTool({
  name: "memory_read",
  description: "Read one of a bot's memory files.",
  input: z.object({ bot: BotRef, name: FileName }),
  annotations: { readOnlyHint: true },
  async run({ bot, name }, context) {
    const { id } = await botByRef(context, bot);
    const { text } = await readMemory(id, name);
    return result(text || `${name} is empty.`, { name, text });
  },
});

const memoryWrite = defineControlTool({
  name: "memory_write",
  description:
    "Replace a memory file's text, creating it if needed. The change is journaled and can be undone.",
  input: z.object({ bot: BotRef, name: FileName, text: z.string().max(200_000) }),
  async run({ bot, name, text }, context) {
    const { id } = await botByRef(context, bot);
    await context.journal.write(id, name, text);
    return result(`Saved ${name}.`, { ok: true, name });
  },
});

const memoryDelete = defineControlTool({
  name: "memory_delete",
  description: "Delete a memory file. The deletion is journaled and can be undone.",
  input: z.object({ bot: BotRef, name: FileName, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ bot, name }, context) {
    const { id } = await botByRef(context, bot);
    await context.journal.write(id, name, null);
    return result(`Deleted ${name}.`, { ok: true, name });
  },
});

const memoryLog = defineControlTool({
  name: "memory_log",
  description: "List the days in a bot's daily log, or read one day's log when day is given.",
  input: z.object({ bot: BotRef, day: LogDay.optional() }),
  annotations: { readOnlyHint: true },
  async run({ bot, day }, context) {
    const { id } = await botByRef(context, bot);
    const { days } = await listLogDays(id);
    if (day) {
      const { text } = await readLogDay(id, day);
      return result(text || `No log for ${day}.`, { days, text });
    }
    const summary = days.map((entry) => `${entry.day} (${entry.lines})`).join(", ");
    return result(summary ? `Log days: ${summary}.` : "No daily log yet.", { days, text: null });
  },
});

const memoryLogDelete = defineControlTool({
  name: "memory_log_delete",
  description: "Delete one day of a bot's daily log.",
  input: z.object({ bot: BotRef, day: LogDay, confirm: Confirm }),
  annotations: { destructiveHint: true },
  async run({ bot, day }, context) {
    const { id } = await botByRef(context, bot);
    await deleteLogDay(id, day);
    return result(`Deleted the log for ${day}.`, { ok: true, day });
  },
});

const memoryJournal = defineControlTool({
  name: "memory_journal",
  description: "List recent changes to a bot's memory files, newest first, with whether each can be undone.",
  input: z.object({ bot: BotRef }),
  annotations: { readOnlyHint: true },
  async run({ bot }, context) {
    const { id } = await botByRef(context, bot);
    const entries = await context.journal.rows(id);
    const lines = entries.map(
      (entry) => `${entry.id}: ${entry.kind} ${entry.file} by ${entry.actor} at ${entry.at}`,
    );
    return result(lines.length ? lines.join("\n") : "No memory changes yet.", { entries });
  },
});

const memoryUndo = defineControlTool({
  name: "memory_undo",
  description: "Undo one memory journal entry, restoring the file as it was before.",
  input: z.object({
    bot: BotRef,
    id: z.string().regex(JOURNAL_ID).describe("A journal entry id from memory_journal."),
  }),
  async run({ bot, id }, context) {
    const target = await botByRef(context, bot);
    await context.journal.undo(target.id, id);
    return result(`Undid ${id}.`, { ok: true, id });
  },
});

export const MEMORY_TOOLS: readonly ControlTool[] = [
  memoryList,
  memoryRead,
  memoryWrite,
  memoryDelete,
  memoryLog,
  memoryLogDelete,
  memoryJournal,
  memoryUndo,
];
