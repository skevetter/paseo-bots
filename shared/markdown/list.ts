import { type BlockScan, indentOf, interruptsParagraph, LIST_ITEM, RULE, stripIndent } from "./block-scan";
import { requiredGroup } from "./helpers";
import { matchTableStart } from "./table";

interface ListKind {
  ordered: boolean;
  delimiter: string;
  start: number;
}

interface ListItemDraft {
  width: number;
  lines: string[];
  blankInside: boolean;
  loose: boolean;
}

export function listKind(marker: string): ListKind {
  const ordered = /\d/.test(marker);
  return {
    ordered,
    delimiter: ordered ? marker.slice(-1) : marker,
    start: ordered ? parseInt(marker, 10) : 1,
  };
}

export function matchNextListItem(line: string | undefined, kind: ListKind): RegExpExecArray | null {
  if (line === undefined || RULE.test(line)) return null;
  const match = LIST_ITEM.exec(line);
  if (!match) return null;
  const marker = requiredGroup(match, 2);
  const sameKind = kind.ordered
    ? /\d/.test(marker) && marker.slice(-1) === kind.delimiter
    : marker === kind.delimiter;
  return sameKind ? match : null;
}

function startListItem(match: RegExpExecArray): ListItemDraft {
  const markerWidth = requiredGroup(match, 1).length + requiredGroup(match, 2).length;
  const spacing = match[3] ? indentOf(match[3]) : 1;
  const content = match[4];
  const contentStart = content === undefined || !content.trim() || spacing > 4 ? 1 : spacing;
  let firstLine = content ?? "";
  if (content !== undefined && spacing > 4) firstLine = " ".repeat(spacing - 1) + content;
  return { width: markerWidth + contentStart, lines: [firstLine], blankInside: false, loose: false };
}

function extendListItem(state: BlockScan, item: ListItemDraft, line: string): boolean {
  if (!line.trim()) {
    item.lines.push("");
    item.blankInside = true;
    return true;
  }
  if (indentOf(line) >= item.width) {
    if (item.blankInside && item.lines.some((entry) => entry.trim())) item.loose = true;
    item.blankInside = false;
    item.lines.push(stripIndent(line, item.width));
    return true;
  }
  // Lazy paragraph continuation.
  const lazy =
    !item.blankInside &&
    !interruptsParagraph(line) &&
    !LIST_ITEM.test(line) &&
    matchTableStart(state.lines, state.i) === null;
  if (lazy) item.lines.push(line.trimStart());
  return lazy;
}

export function collectListItem(state: BlockScan, match: RegExpExecArray): ListItemDraft {
  const item = startListItem(match);
  state.i++;
  let line = state.lines[state.i];
  while (line !== undefined && extendListItem(state, item, line)) {
    state.i++;
    line = state.lines[state.i];
  }
  return item;
}
