import type { Inline } from "./types";

const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/g;

export function linkify(inlines: Inline[]): Inline[] {
  return inlines.flatMap((inline): Inline[] => {
    if (inline.kind === "text") return linkifyText(inline.text);
    if (inline.kind === "bold" || inline.kind === "italic" || inline.kind === "strike")
      return [{ ...inline, children: linkify(inline.children) }];
    return [inline];
  });
}

function trimUnmatchedParens(match: string): string {
  let url = match;
  // Keep balanced parentheses, drop a trailing unmatched one.
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0))
    url = url.slice(0, -1);
  return url;
}

function linkifyText(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  BARE_URL.lastIndex = 0;
  for (let match = BARE_URL.exec(text); match; match = BARE_URL.exec(text)) {
    const before = text[match.index - 1];
    if (before && /[\w@/]/.test(before)) continue;
    const url = trimUnmatchedParens(match[0]);
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    out.push({
      kind: "link",
      url: url.startsWith("www.") ? `http://${url}` : url,
      children: [{ kind: "text", text: url }],
    });
    last = match.index + url.length;
    BARE_URL.lastIndex = last;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}
