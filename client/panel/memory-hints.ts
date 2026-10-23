import { plural } from "../../shared/activity";
import { kb } from "../../shared/bot-checks";
import type { MemoryBudgetStats } from "../../shared/memory-budget";

interface MemoryFileInfo {
  name: string;
  bytes: number;
  lines: number;
  topic: boolean;
}

export function memoryFileHint(file: MemoryFileInfo, injected: MemoryBudgetStats | undefined): string {
  if (!injected) return "Loading...";
  if (file.topic) return `${plural(file.lines, "line")} · ${kb(file.bytes)} KB`;
  const { truncation, includedLines, includedBytes, totalLines, totalBytes, maxLines, maxBytes } = injected;
  const shown = truncation
    ? `${includedLines} of ${totalLines} lines · ${kb(includedBytes)} of ${kb(totalBytes)} KB`
    : `${totalLines} of ${maxLines} lines · ${kb(totalBytes)} of ${kb(maxBytes)} KB`;
  return `${shown} loaded into every chat`;
}

/** Why the end of MEMORY.md never reaches the bot, or null when all of it does. */
export function memoryBudgetError(injected: MemoryBudgetStats | undefined): string | null {
  if (!injected?.truncation) return null;
  const cap = injected.truncation === "lines" ? `${injected.maxLines}-line` : `${kb(injected.maxBytes)} KB`;
  return `Over the ${cap} limit: the last ${plural(injected.omittedLines, "line")} (${kb(injected.omittedBytes)} KB) are left out of every chat`;
}
