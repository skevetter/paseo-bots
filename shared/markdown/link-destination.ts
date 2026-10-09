function skipLinkWhitespace(src: string, start: number): number {
  let i = start;
  while (i < src.length && /[ \t\n]/.test(src.charAt(i))) i++;
  return i;
}

export interface LinkTarget {
  url: string;
  end: number;
}

/** `start` is just after "](", `end` just after ")". */
export function parseLinkTail(src: string, start: number): LinkTarget | null {
  const destination = parseLinkDestination(src, skipLinkWhitespace(src, start));
  if (!destination) return null;
  const end = skipLinkTitle(src, skipLinkWhitespace(src, destination.end));
  if (end === null || src[end] !== ")") return null;
  return { url: destination.url, end: end + 1 };
}

function parseLinkDestination(src: string, start: number): LinkTarget | null {
  if (src[start] === "<") {
    const close = src.indexOf(">", start + 1);
    if (close < 0 || src.slice(start + 1, close).includes("\n")) return null;
    return { url: src.slice(start + 1, close), end: close + 1 };
  }
  const end = scanBareDestination(src, start);
  return { url: src.slice(start, end).replace(/\\([!-/:-@[-`{-~])/g, "$1"), end };
}

const DESTINATION_UNIT = /\\[!-/:-@[-`{-~]|[()]|[^\s()\\]+|\\/y;

function scanBareDestination(src: string, start: number): number {
  let depth = 0;
  let end = start;
  DESTINATION_UNIT.lastIndex = start;
  for (let unit = DESTINATION_UNIT.exec(src); unit; unit = DESTINATION_UNIT.exec(src)) {
    if (unit[0] === ")" && depth === 0) break;
    if (unit[0] === "(") depth++;
    else if (unit[0] === ")") depth--;
    end = DESTINATION_UNIT.lastIndex;
  }
  return end;
}

function skipLinkTitle(src: string, start: number): number | null {
  const quote = src[start];
  if (quote !== '"' && quote !== "'" && quote !== "(") return start;
  const close = src.indexOf(quote === "(" ? ")" : quote, start + 1);
  return close < 0 ? null : skipLinkWhitespace(src, close + 1);
}
