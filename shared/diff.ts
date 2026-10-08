import { lcsAlign } from "./tools";

// A small line diff for the memory change journal: unified hunks with two
// lines of context, like `diff -U2`, plus the added and removed line counts.

const CONTEXT = 2;
/** Beyond this many differing lines on each side the hunks are skipped and only counts are kept. */
const MAX_MIDDLE = 1_000;

type Op = { kind: " " | "-" | "+"; line: string };

function splitLines(text: string): string[] {
  if (!text) return [];
  return text.replace(/\n$/, "").split("\n");
}

function nextChangeAfterContext(ops: readonly Op[], end: number): number {
  let next = end;
  while (next < ops.length && ops[next].kind === " ") next++;
  return next;
}

function hunkEnd(ops: readonly Op[], index: number): number {
  let end = index;
  // Extend over changes that are close enough to share context.
  while (end < ops.length) {
    if (ops[end].kind !== " ") {
      end++;
      continue;
    }
    const next = nextChangeAfterContext(ops, end);
    if (next < ops.length && next - end <= CONTEXT * 2) end = next;
    else break;
  }
  return end;
}

function hunkHeader(slice: readonly Op[], first: { old: number; new: number }): string {
  const oldCount = slice.filter((op) => op.kind !== "+").length;
  const newCount = slice.filter((op) => op.kind !== "-").length;
  return `@@ -${oldCount ? first.old : first.old - 1},${oldCount} +${newCount ? first.new : first.new - 1},${newCount} @@`;
}

function hunks(ops: readonly Op[]): string {
  const out: string[] = [];
  let index = 0;
  let oldLine = 1;
  let newLine = 1;
  const lineNumbers = ops.map((op) => {
    const at = { old: oldLine, new: newLine };
    if (op.kind !== "+") oldLine++;
    if (op.kind !== "-") newLine++;
    return at;
  });
  while (index < ops.length) {
    if (ops[index].kind === " ") {
      index++;
      continue;
    }
    const start = Math.max(0, index - CONTEXT);
    const stop = Math.min(ops.length, hunkEnd(ops, index) + CONTEXT);
    const slice = ops.slice(start, stop);
    out.push(hunkHeader(slice, lineNumbers[start]));
    for (const op of slice) out.push(`${op.kind}${op.line}`);
    index = stop;
  }
  return out.join("\n");
}

export function lineDiff(
  before: string,
  after: string,
  maxChars = 8_000,
): { diff: string; added: number; removed: number } {
  const a = splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);
  if (middleA.length > MAX_MIDDLE || middleB.length > MAX_MIDDLE) {
    return { diff: "", added: middleB.length, removed: middleA.length };
  }
  const ops: Op[] = [
    ...a.slice(0, prefix).map((line) => ({ kind: " " as const, line })),
    // The edit script for the lines between the shared prefix and suffix.
    ...lcsAlign(middleA, middleB).map(({ kind, value }) => ({ kind, line: value })),
    ...a.slice(a.length - suffix).map((line) => ({ kind: " " as const, line })),
  ];
  const diff = hunks(ops);
  return {
    diff: diff.length > maxChars ? `${diff.slice(0, maxChars)}\n…` : diff,
    added: ops.filter((op) => op.kind === "+").length,
    removed: ops.filter((op) => op.kind === "-").length,
  };
}
