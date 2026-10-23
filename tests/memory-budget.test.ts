import { describe, expect, it } from "vitest";
import { memoryBudgetError, memoryFileHint } from "../client/panel/memory-hints";
import { utf8Bytes } from "../shared/bot-checks";
import {
  budgetMemory,
  budgetStats,
  countLines,
  MEMORY_MAX_BYTES,
  MEMORY_MAX_LINES,
} from "../shared/memory-budget";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");

describe("memory budget", () => {
  it("keeps exactly 200 lines and cuts the 201st, reporting what was left out", () => {
    const fits = budgetMemory(numbered(MEMORY_MAX_LINES));
    expect(fits).toMatchObject({ truncation: null, includedLines: 200, omittedLines: 0, omittedBytes: 0 });

    const text = numbered(MEMORY_MAX_LINES + 50);
    const cut = budgetMemory(text);
    expect(cut).toMatchObject({
      truncation: "lines",
      totalLines: 250,
      includedLines: 200,
      omittedLines: 50,
      totalBytes: utf8Bytes(text),
    });
    expect(cut.text).toBe(numbered(MEMORY_MAX_LINES));
    expect(utf8Bytes(cut.text)).toBe(cut.includedBytes);
    expect(cut.includedBytes + cut.omittedBytes).toBe(cut.totalBytes);
  });

  it("keeps exactly 24,000 bytes and cuts at the line before the one that passes it", () => {
    const exact = `${"a".repeat(12_000)}\n${"b".repeat(11_999)}`;
    expect(utf8Bytes(exact)).toBe(MEMORY_MAX_BYTES);
    expect(budgetMemory(exact)).toMatchObject({ truncation: null, text: exact, omittedBytes: 0 });

    expect(budgetMemory(`${exact}\nc`)).toMatchObject({
      truncation: "bytes",
      includedLines: 2,
      omittedLines: 1,
      omittedBytes: 2,
      includedBytes: MEMORY_MAX_BYTES,
    });
    // One byte more on the last line drops the whole line, not just its end.
    expect(budgetMemory(`${exact}b`)).toMatchObject({ truncation: "bytes", includedLines: 1 });
  });

  it("counts bytes, not characters, and never splits a multibyte character", () => {
    const line = "\u00e9".repeat(6_000); // 12,000 bytes
    const cut = budgetMemory([line, line, line].join("\n"));
    expect(cut.totalBytes).toBe(36_002);
    expect(cut).toMatchObject({ truncation: "bytes", includedLines: 1, omittedLines: 2 });
    expect(cut.text).toBe(line);

    const emoji = "\u{1F600}".repeat(3_000); // 12,000 bytes, 6,000 UTF-16 units
    expect(budgetMemory(emoji).totalBytes).toBe(12_000);
    expect(budgetMemory(`${emoji}\n${emoji}\n${emoji}`).includedLines).toBe(1);
  });

  it("leaves nothing in when the first line alone is over the byte cap", () => {
    const text = `${"x".repeat(MEMORY_MAX_BYTES + 1)}\nsecond`;
    expect(budgetMemory(text)).toMatchObject({
      text: "",
      truncation: "bytes",
      includedLines: 0,
      includedBytes: 0,
      omittedLines: 2,
      omittedBytes: MEMORY_MAX_BYTES + 1 + 1 + 6,
    });
  });

  it("reports an empty file as nothing", () => {
    expect(budgetMemory("")).toMatchObject({
      text: "",
      truncation: null,
      totalLines: 0,
      totalBytes: 0,
      includedLines: 0,
    });
    expect(countLines("")).toBe(0);
  });

  it("does not count the newline ending the last line as another line", () => {
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\n\n")).toBe(2);
    expect(countLines("\n")).toBe(1);

    const full = `${numbered(MEMORY_MAX_LINES)}\n`;
    const kept = budgetMemory(full);
    expect(kept).toMatchObject({ truncation: null, totalLines: 200, includedLines: 200 });
    expect(kept.text).toBe(full);

    const cut = budgetMemory(`${numbered(MEMORY_MAX_LINES + 1)}\n`);
    expect(cut).toMatchObject({ truncation: "lines", totalLines: 201, omittedLines: 1 });
    expect(cut.text).toBe(numbered(MEMORY_MAX_LINES));
  });

  it("blames the byte cap when only the final newline pushes the text over it", () => {
    const text = `${"a".repeat(MEMORY_MAX_BYTES)}\n`;
    const cut = budgetMemory(text);
    expect(cut).toMatchObject({ truncation: "bytes", includedLines: 1, omittedLines: 0, omittedBytes: 1 });
  });
});

describe("memory budget in the panel", () => {
  const main = { name: "MEMORY.md", bytes: 0, lines: 0, topic: false };

  it("tells a file over the cap how much is left out, which the clipped counters could not", () => {
    const stats = budgetStats(budgetMemory(numbered(300)));
    expect(memoryBudgetError(stats)).toBe(
      "Over the 200-line limit: the last 100 lines (0.9 KB) are left out of every chat",
    );
    expect(memoryFileHint(main, stats)).toBe("200 of 300 lines \u00b7 1.7 of 2.6 KB loaded into every chat");
  });

  it("names the byte cap when it is the one that cut", () => {
    const stats = budgetStats(budgetMemory(`${"x".repeat(MEMORY_MAX_BYTES + 1)}\nsecond`));
    expect(memoryBudgetError(stats)).toBe(
      "Over the 24.0 KB limit: the last 2 lines (24.0 KB) are left out of every chat",
    );
  });

  it("shows headroom and no error while everything fits", () => {
    const stats = budgetStats(budgetMemory("# Memory\n- likes tea\n"));
    expect(memoryBudgetError(stats)).toBeNull();
    expect(memoryFileHint(main, stats)).toBe("2 of 200 lines · 0.0 of 24.0 KB loaded into every chat");
    expect(memoryFileHint(main, undefined)).toBe("Loading...");
  });
});
