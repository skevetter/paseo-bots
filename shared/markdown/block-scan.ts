import { requiredGroup } from "./helpers";
import { parseInline } from "./inline";
import type { Block, References } from "./types";

export const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
export const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
export const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
export const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
export const QUOTE = /^ {0,3}> ?(.*)$/;
export const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;

export function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Removes `width` columns of leading indentation. */
export function stripIndent(line: string, width: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < width) {
    const char = line.charAt(index);
    if (char === " ") removed++;
    else if (char === "\t") removed += 4 - (removed % 4);
    else break;
    index++;
  }
  return line.slice(index);
}

export function popTrailingBlanks(lines: string[], minimum: number): number {
  let popped = 0;
  while (lines.length > minimum && !lines.at(-1)?.trim()) {
    lines.pop();
    popped++;
  }
  return popped;
}

export function interruptsParagraph(line: string): boolean {
  if (FENCE_OPEN.test(line) || ATX.test(line) || RULE.test(line) || QUOTE.test(line)) return true;
  const item = LIST_ITEM.exec(line);
  if (!item?.[4]?.trim()) return false;
  const marker = requiredGroup(item, 2);
  return !/\d/.test(marker) || /^1[.)]$/.test(marker);
}

interface FenceOpen {
  indent: number;
  marker: string;
  info: string;
}

export function matchFenceOpen(line: string): FenceOpen | null {
  const fence = FENCE_OPEN.exec(line);
  if (!fence) return null;
  const marker = requiredGroup(fence, 2);
  const info = requiredGroup(fence, 3);
  if (marker.startsWith("`") && info.includes("`")) return null;
  return { indent: requiredGroup(fence, 1).length, marker, info };
}

export function fenceCloser(marker: string): RegExp {
  return new RegExp(`^ {0,3}${marker.startsWith("`") ? "`" : "~"}{${marker.length},}[ \\t]*$`);
}

export interface BlockScan {
  lines: string[];
  tail: boolean;
  references: References;
  blocks: Block[];
  paragraph: string[];
  i: number;
}

export function flushParagraph(state: BlockScan, streaming = false): void {
  if (state.paragraph.length === 0) return;
  const content = state.paragraph
    .join("\n")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
  state.paragraph = [];
  if (content)
    state.blocks.push({ kind: "paragraph", inlines: parseInline(content, { streaming }, state.references) });
}

export function takeLinesWhile(state: BlockScan, keep: (line: string) => boolean): string[] {
  const taken: string[] = [];
  for (let line = state.lines[state.i]; line !== undefined && keep(line); line = state.lines[state.i]) {
    taken.push(line);
    state.i++;
  }
  return taken;
}
