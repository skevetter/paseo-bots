// Must render like Paseo's markdown-it setup (utils/assistant-markdown-parser.ts).

import {
  ATX,
  type BlockScan,
  FENCE_OPEN,
  fenceCloser,
  flushParagraph,
  indentOf,
  interruptsParagraph,
  LIST_ITEM,
  matchFenceOpen,
  popTrailingBlanks,
  QUOTE,
  RULE,
  SETEXT,
  stripIndent,
  takeLinesWhile,
} from "./block-scan";
import { requiredGroup } from "./helpers";
import { parseInline } from "./inline";
import { collectListItem, listKind, matchNextListItem } from "./list";
import { collectReferences, scanReferenceDefinition } from "./references";
import { scanTable } from "./table";
import type { Block, ListItem, ParseOptions, References } from "./types";

function scanBlankLine(state: BlockScan, line: string): boolean {
  if (line.trim()) return false;
  flushParagraph(state);
  state.i++;
  return true;
}

function scanIndentedCode(state: BlockScan, line: string): boolean {
  // Indented code can't interrupt a paragraph.
  if (state.paragraph.length > 0 || indentOf(line) < 4) return false;
  const body = takeLinesWhile(state, (current) => indentOf(current) >= 4 || !current.trim()).map((current) =>
    stripIndent(current, 4),
  );
  popTrailingBlanks(body, 0);
  state.blocks.push({ kind: "code", language: "", text: body.join("\n") });
  return true;
}

function scanFencedCode(state: BlockScan, line: string): boolean {
  const fence = matchFenceOpen(line);
  if (!fence) return false;
  flushParagraph(state);
  const close = fenceCloser(fence.marker);
  state.i++;
  const body = takeLinesWhile(state, (current) => !close.test(current)).map((current) =>
    stripIndent(current, fence.indent),
  );
  state.i++;
  state.blocks.push({
    kind: "code",
    language: fence.info.trim().split(/\s+/)[0] ?? "",
    text: body.join("\n"),
  });
  return true;
}

function scanSetextHeading(state: BlockScan, line: string): boolean {
  if (state.paragraph.length === 0) return false;
  const setext = SETEXT.exec(line);
  if (!setext) return false;
  const content = state.paragraph.join("\n").trim();
  state.paragraph = [];
  state.blocks.push({
    kind: "heading",
    level: requiredGroup(setext, 1).startsWith("=") ? 1 : 2,
    inlines: parseInline(content, {}, state.references),
  });
  state.i++;
  return true;
}

function scanAtxHeading(state: BlockScan, line: string): boolean {
  const atx = ATX.exec(line);
  if (!atx) return false;
  flushParagraph(state);
  const content = requiredGroup(atx, 2)
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/^#+[ \t]*$/, "")
    .trim();
  state.blocks.push({
    kind: "heading",
    level: requiredGroup(atx, 1).length,
    inlines: parseInline(content, {}, state.references),
  });
  state.i++;
  return true;
}

function scanRule(state: BlockScan, line: string): boolean {
  if (!RULE.test(line)) return false;
  flushParagraph(state);
  state.blocks.push({ kind: "rule" });
  state.i++;
  return true;
}

function collectQuoteLines(state: BlockScan): string[] {
  const inner: string[] = [];
  let lazy = false;
  for (let current = state.lines[state.i]; current !== undefined; current = state.lines[state.i]) {
    const quoted = QUOTE.exec(current);
    if (quoted) {
      const content = requiredGroup(quoted, 1);
      inner.push(content);
      lazy = content.trim().length > 0 && !FENCE_OPEN.test(content);
    } else if (lazy && current.trim() && !interruptsParagraph(current)) {
      // Lazy continuation of a quoted paragraph.
      inner.push(current);
    } else break;
    state.i++;
  }
  return inner;
}

function scanQuote(state: BlockScan, line: string): boolean {
  if (!QUOTE.test(line)) return false;
  flushParagraph(state);
  const inner = collectQuoteLines(state);
  state.blocks.push({
    kind: "quote",
    blocks: parseBlocks(inner, state.tail && state.i >= state.lines.length, state.references),
  });
  return true;
}

function scanList(state: BlockScan, line: string): boolean {
  const item = LIST_ITEM.exec(line);
  if (!item || (state.paragraph.length > 0 && !interruptsParagraph(line))) return false;
  flushParagraph(state);
  state.blocks.push(parseList(state, requiredGroup(item, 2)));
  return true;
}

const BLOCK_SCANNERS: ((state: BlockScan, line: string) => boolean)[] = [
  scanBlankLine,
  scanIndentedCode,
  scanFencedCode,
  scanSetextHeading,
  scanAtxHeading,
  scanRule,
  scanQuote,
  scanList,
  scanTable,
  scanReferenceDefinition,
];

function parseBlocks(lines: string[], tail: boolean, references: References): Block[] {
  const state: BlockScan = { lines, tail, references, blocks: [], paragraph: [], i: 0 };
  for (let line = lines[state.i]; line !== undefined; line = lines[state.i]) {
    if (BLOCK_SCANNERS.some((scan) => scan(state, line))) continue;
    state.paragraph.push(line);
    state.i++;
  }
  flushParagraph(state, tail);
  return state.blocks;
}

function parseList(state: BlockScan, marker: string): Block {
  const kind = listKind(marker);
  const items: string[][] = [];
  let tight = true;
  let sawBlank = false;
  for (
    let match = matchNextListItem(state.lines[state.i], kind);
    match;
    match = matchNextListItem(state.lines[state.i], kind)
  ) {
    if (sawBlank) tight = false;
    const item = collectListItem(state, match);
    if (item.loose) tight = false;
    // Trailing blank lines belong between items, not inside this one.
    sawBlank = popTrailingBlanks(item.lines, 1) > 0;
    items.push(item.lines);
    const next = state.lines[state.i];
    if (sawBlank && next !== undefined && !LIST_ITEM.test(next)) break;
  }
  const atEnd = state.tail && state.lines.slice(state.i).every((line) => !line.trim());
  const parsed = items.map(
    (lines, index): ListItem => ({
      marker: kind.ordered ? `${kind.start + index}${kind.delimiter}` : "•",
      blocks: parseBlocks(lines, atEnd && index === items.length - 1, state.references),
    }),
  );
  return { kind: "list", ordered: kind.ordered, start: kind.start, tight, items: parsed };
}

export function parseMarkdown(source: string, options: ParseOptions = {}): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const references: References = Object.assign(new Map<string, string>(), {
    linkify: options.linkify !== false,
  });
  collectReferences(lines, references);
  popTrailingBlanks(lines, 0);
  return parseBlocks(lines, options.streaming === true, references);
}
