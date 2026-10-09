import { type BlockScan, flushParagraph, indentOf, interruptsParagraph, takeLinesWhile } from "./block-scan";
import { parseInline } from "./inline";
import type { TableAlign } from "./types";

const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function trimRowPipes(line: string): string {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row;
}

const ROW_UNIT = /\\\||`+|\||[^`|\\]+|\\/y;

function toggleCodeSpan(openRun: number, run: number): number {
  if (openRun === run) return 0;
  return openRun || run;
}

function splitRow(line: string): string[] {
  const row = trimRowPipes(line);
  const cells: string[] = [];
  let current = "";
  let inCode = 0;
  ROW_UNIT.lastIndex = 0;
  for (let unit = ROW_UNIT.exec(row); unit; unit = ROW_UNIT.exec(row)) {
    const [text] = unit;
    if (text === "|" && inCode === 0) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    if (text.startsWith("`")) inCode = toggleCodeSpan(inCode, text.length);
    current += text === "\\|" ? "|" : text;
  }
  cells.push(current.trim());
  return cells;
}

export function matchTableStart(
  lines: string[],
  i: number,
): { header: string[]; delimiter: string[] } | null {
  const header = lines[i];
  const delimiter = lines[i + 1];
  if (
    header === undefined ||
    delimiter === undefined ||
    !header.includes("|") ||
    !TABLE_DELIMITER.test(delimiter) ||
    indentOf(header) >= 4
  )
    return null;
  const headerCells = splitRow(header);
  const delimiterCells = splitRow(delimiter);
  return headerCells.length === delimiterCells.length
    ? { header: headerCells, delimiter: delimiterCells }
    : null;
}

function cellAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

export function scanTable(state: BlockScan): boolean {
  const table = matchTableStart(state.lines, state.i);
  if (!table) return false;
  flushParagraph(state);
  state.i += 2;
  const rows = takeLinesWhile(
    state,
    (current) => current.trim() !== "" && current.includes("|") && !interruptsParagraph(current),
  );
  state.blocks.push({
    kind: "table",
    align: table.delimiter.map(cellAlign),
    header: table.header.map((cell) => parseInline(cell, {}, state.references)),
    rows: rows.map((row) => {
      const cells = splitRow(row);
      return table.header.map((_, column) => parseInline(cells[column] ?? "", {}, state.references));
    }),
  });
  return true;
}
