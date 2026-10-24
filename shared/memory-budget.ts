import { z } from "zod";
import { utf8Bytes } from "./bot-checks";

/** The part of MEMORY.md loaded into every chat. Whole lines only, so the cut never lands inside a line. */
export const MEMORY_MAX_LINES = 200;
export const MEMORY_MAX_BYTES = 24_000;

/** Sizes are UTF-8 bytes of the text; nothing here estimates tokens. */
export const MEMORY_ESTIMATOR = "utf8-bytes";

export const MemoryBudgetStatsSchema = z.object({
  totalLines: z.number(),
  totalBytes: z.number(),
  includedLines: z.number(),
  includedBytes: z.number(),
  omittedLines: z.number(),
  omittedBytes: z.number(),
  /** The cap that cut the text, or null when all of it fits. */
  truncation: z.enum(["lines", "bytes"]).nullable(),
  estimator: z.literal(MEMORY_ESTIMATOR),
  maxLines: z.number(),
  maxBytes: z.number(),
});
export type MemoryBudgetStats = z.infer<typeof MemoryBudgetStatsSchema>;
export type MemoryBudget = MemoryBudgetStats & { text: string };

export interface MemoryLimits {
  maxLines: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: MemoryLimits = { maxLines: MEMORY_MAX_LINES, maxBytes: MEMORY_MAX_BYTES };

/** The lines of `text`; the newline ending the last line doesn't start another. */
function linesOf(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function countLines(text: string): number {
  return linesOf(text).length;
}

export function budgetStats({ text: _text, ...stats }: MemoryBudget): MemoryBudgetStats {
  return stats;
}

/** Cuts `text` to the caps at a line boundary and reports what was left out. */
export function budgetMemory(text: string, limits: MemoryLimits = DEFAULT_LIMITS): MemoryBudget {
  const lines = linesOf(text);
  const totalBytes = utf8Bytes(text);
  const base = { totalLines: lines.length, totalBytes, ...limits, estimator: MEMORY_ESTIMATOR } as const;
  if (lines.length <= limits.maxLines && totalBytes <= limits.maxBytes) {
    return {
      ...base,
      text,
      includedLines: lines.length,
      includedBytes: totalBytes,
      omittedLines: 0,
      omittedBytes: 0,
      truncation: null,
    };
  }

  let included = 0;
  let includedBytes = 0;
  let cutByBytes = false;
  for (const line of lines.slice(0, limits.maxLines)) {
    const next = includedBytes + (included ? 1 : 0) + utf8Bytes(line);
    if (next > limits.maxBytes) {
      cutByBytes = true;
      break;
    }
    included += 1;
    includedBytes = next;
  }
  // With every line kept, only the final newline can push the text over the byte cap.
  const truncation = cutByBytes || lines.length <= limits.maxLines ? "bytes" : "lines";
  return {
    ...base,
    text: lines.slice(0, included).join("\n"),
    includedLines: included,
    includedBytes,
    omittedLines: lines.length - included,
    omittedBytes: totalBytes - includedBytes,
    truncation,
  };
}
