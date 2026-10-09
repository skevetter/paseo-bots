import { type BlockScan, fenceCloser, matchFenceOpen } from "./block-scan";
import { normalizeLabel, requiredGroup } from "./helpers";
import type { References } from "./types";

const REFERENCE = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

export function collectReferences(lines: string[], references: References): void {
  let close: RegExp | null = null;
  for (const line of lines) {
    if (close) {
      if (close.test(line)) close = null;
      continue;
    }
    const fence = matchFenceOpen(line);
    if (fence) {
      close = fenceCloser(fence.marker);
      continue;
    }
    addReference(references, line);
  }
}

function addReference(references: References, line: string): void {
  const reference = REFERENCE.exec(line);
  if (!reference) return;
  const key = normalizeLabel(requiredGroup(reference, 1));
  if (!references.has(key)) references.set(key, requiredGroup(reference, 2));
}

export function scanReferenceDefinition(state: BlockScan, line: string): boolean {
  if (state.paragraph.length > 0 || !REFERENCE.test(line)) return false;
  state.i++;
  return true;
}
