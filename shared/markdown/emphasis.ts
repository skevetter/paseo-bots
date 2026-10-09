import type { Inline } from "./types";

export interface Delim {
  kind: "delim";
  char: "*" | "_" | "~";
  count: number;
  original: number;
  canOpen: boolean;
  canClose: boolean;
}

export interface Bracket {
  kind: "bracket";
  image: boolean;
  /** Source index just after the opening "[". */
  start: number;
  active: boolean;
}

export type Token = Inline | Delim | Bracket;

export function pushText(tokens: Token[], text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last?.kind === "text") last.text += text;
  else tokens.push({ kind: "text", text });
}

function emphasisKind(char: Delim["char"], use: number): "strike" | "bold" | "italic" {
  if (char === "~") return "strike";
  return use === 2 ? "bold" : "italic";
}

/** CommonMark's "process emphasis"; leftover delimiters become text. */
export function processEmphasis(tokens: Token[], streaming: boolean): Inline[] {
  let i = 0;
  while (i < tokens.length) i = matchEmphasisAt(tokens, i);
  if (streaming) closeStreamingEmphasis(tokens);
  return finish(tokens);
}

interface OpenDelim {
  index: number;
  opener: Delim;
}

function matchEmphasisAt(tokens: Token[], i: number): number {
  const closer = tokens[i];
  if (closer?.kind !== "delim" || !closer.canClose || closer.count === 0) return i + 1;
  const match = findEmphasisOpener(tokens, i, closer);
  if (!match) return i + 1;
  const { index: found, opener } = match;
  const use = closer.char === "~" || (opener.count >= 2 && closer.count >= 2) ? 2 : 1;
  const node: Inline = { kind: emphasisKind(closer.char, use), children: finish(tokens.slice(found + 1, i)) };
  opener.count -= use;
  closer.count -= use;
  const replacement: Token[] = [];
  if (opener.count > 0) replacement.push(opener);
  replacement.push(node);
  if (closer.count > 0) replacement.push(closer);
  tokens.splice(found, i - found + 1, ...replacement);
  return found + replacement.length - (closer.count > 0 ? 1 : 0);
}

function canOpenFor(token: Token | undefined, closer: Delim): token is Delim {
  return token?.kind === "delim" && token.char === closer.char && token.canOpen && token.count !== 0;
}

function failsRuleOfThree(opener: Delim, closer: Delim): boolean {
  return (
    (opener.canClose || closer.canOpen) &&
    (opener.original + closer.original) % 3 === 0 &&
    !(opener.original % 3 === 0 && closer.original % 3 === 0)
  );
}

function findEmphasisOpener(tokens: Token[], closerIndex: number, closer: Delim): OpenDelim | null {
  for (let index = closerIndex - 1; index >= 0; index--) {
    const opener = tokens[index];
    if (!canOpenFor(opener, closer)) continue;
    const pairs =
      closer.char === "~" ? opener.count === 2 && closer.count === 2 : !failsRuleOfThree(opener, closer);
    if (pairs) return { index, opener };
  }
  return null;
}

function isStreamingOpener(token: Token | undefined): token is Delim {
  return (
    token?.kind === "delim" && token.canOpen && token.count !== 0 && (token.char !== "~" || token.count === 2)
  );
}

function closeStreamingEmphasis(tokens: Token[]): void {
  for (let j = tokens.length - 1; j >= 0; j--) {
    const opener = tokens[j];
    if (!isStreamingOpener(opener)) continue;
    const rest = tokens.slice(j + 1);
    if (!rest.some((token) => token.kind !== "text" || token.text.trim())) continue;
    const use = opener.char === "~" ? 2 : Math.min(2, opener.count);
    opener.count -= use;
    tokens.splice(j + 1, rest.length, { kind: emphasisKind(opener.char, use), children: finish(rest) });
    if (opener.count === 0) tokens.splice(j, 1);
  }
}

function literalText(token: Delim | Bracket | Extract<Inline, { kind: "text" }>): string {
  if (token.kind === "delim") return token.char.repeat(token.count);
  if (token.kind === "bracket") return token.image ? "![" : "[";
  return token.text;
}

function finish(tokens: Token[]): Inline[] {
  const out: Inline[] = [];
  for (const token of tokens) {
    if (token.kind === "delim" || token.kind === "bracket" || token.kind === "text")
      pushText(out, literalText(token));
    else out.push(token);
  }
  return out;
}
