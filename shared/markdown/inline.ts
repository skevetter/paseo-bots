import { type Bracket, type Delim, processEmphasis, pushText, type Token } from "./emphasis";
import { normalizeLabel, requiredGroup } from "./helpers";
import { type LinkTarget, parseLinkTail } from "./link-destination";
import { linkify } from "./linkify";
import type { Inline, ParseOptions, References } from "./types";

const PUNCTUATION = /[!-/:-@[-`{-~ -⁯⸀-⹿　-〿]/;
const ESCAPABLE = /[!-/:-@[-`{-~]/;
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  hellip: "…",
  mdash: "—",
  ndash: "–",
};

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isPunct = (char: string | undefined) => char !== undefined && PUNCTUATION.test(char);

function runLength(text: string, start: number, char: string): number {
  let length = 0;
  while (text[start + length] === char) length++;
  return length;
}

function skipSpacesAndTabs(src: string, start: number): number {
  let i = start;
  while (src[i] === " " || src[i] === "\t") i++;
  return i;
}

export function plainText(inlines: Inline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case "text":
        case "code":
          return inline.text;
        case "break":
          return "\n";
        case "image":
          return inline.alt;
        default:
          return plainText(inline.children);
      }
    })
    .join("");
}

const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK =
  /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;

const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/;

interface InlineScan {
  src: string;
  streaming: boolean;
  references: References;
  tokens: Token[];
  i: number;
  text: string;
}

interface OpenBracket {
  index: number;
  bracket: Bracket;
}

function flushText(state: InlineScan): void {
  pushText(state.tokens, state.text);
  state.text = "";
}

function scanBackslash(state: InlineScan): boolean {
  if (state.src[state.i] !== "\\") return false;
  const next = state.src.charAt(state.i + 1);
  if (next === "\n") {
    flushText(state);
    state.tokens.push({ kind: "break" });
    state.i = skipSpacesAndTabs(state.src, state.i + 2);
  } else if (ESCAPABLE.test(next)) {
    state.text += next;
    state.i += 2;
  } else {
    state.text += "\\";
    state.i++;
  }
  return true;
}

function scanLineBreak(state: InlineScan): boolean {
  if (state.src[state.i] !== "\n") return false;
  state.text = state.text.replace(/[ \t]+$/, "");
  flushText(state);
  const last = state.tokens.at(-1);
  if (last?.kind === "text") last.text = last.text.replace(/[ \t]+$/, "");
  state.tokens.push({ kind: "break" });
  state.i = skipSpacesAndTabs(state.src, state.i + 1);
  return true;
}

function findCodeSpanClose(src: string, from: number, run: number): number {
  const fence = "`".repeat(run);
  let search = from;
  while (search < src.length) {
    const at = src.indexOf(fence, search);
    if (at < 0) return -1;
    const length = runLength(src, at, "`");
    if (length === run) return at;
    search = at + length;
  }
  return -1;
}

function codeSpanBody(raw: string): string {
  const body = raw.replace(/\n/g, " ");
  const padded = body.length > 1 && body.startsWith(" ") && body.endsWith(" ") && body.trim() !== "";
  return padded ? body.slice(1, -1) : body;
}

function scanCodeSpan(state: InlineScan): boolean {
  const { src, i } = state;
  if (src[i] !== "`") return false;
  const run = runLength(src, i, "`");
  const close = findCodeSpanClose(src, i + run, run);
  if (close >= 0) {
    flushText(state);
    state.tokens.push({ kind: "code", text: codeSpanBody(src.slice(i + run, close)) });
    state.i = close + run;
  } else if (state.streaming) {
    // Unclosed code at the streaming tail still renders as code.
    const body = src.slice(i + run).replace(/`+$/, "");
    flushText(state);
    if (body) state.tokens.push({ kind: "code", text: body.replace(/\n/g, " ") });
    state.i = src.length;
  } else {
    state.text += "`".repeat(run);
    state.i += run;
  }
  return true;
}

function delimiterFlanking(
  src: string,
  start: number,
  run: number,
  char: Delim["char"],
): { canOpen: boolean; canClose: boolean } {
  const before = start === 0 ? undefined : src[start - 1];
  const after = src[start + run];
  const left = !isSpace(after) && (!isPunct(after) || isSpace(before) || isPunct(before));
  const right = !isSpace(before) && (!isPunct(before) || isSpace(after) || isPunct(after));
  if (char !== "_") return { canOpen: left, canClose: right };
  return { canOpen: left && (!right || isPunct(before)), canClose: right && (!left || isPunct(after)) };
}

function scanDelimiterRun(state: InlineScan): boolean {
  const { src, i } = state;
  const char = src.charAt(i);
  if (char !== "*" && char !== "_" && char !== "~") return false;
  const run = runLength(src, i, char);
  state.i += run;
  if (char === "~" && run !== 2) {
    state.text += char.repeat(run);
    return true;
  }
  const { canOpen, canClose } = delimiterFlanking(src, i, run, char);
  // A lone opening marker at the streaming tail is hidden until its text arrives.
  if (state.streaming && i + run === src.length && !canClose) return true;
  flushText(state);
  state.tokens.push({ kind: "delim", char, count: run, original: run, canOpen, canClose });
  return true;
}

function scanBracketOpen(state: InlineScan): boolean {
  const image = state.src.startsWith("![", state.i);
  if (!image && state.src[state.i] !== "[") return false;
  flushText(state);
  const start = state.i + (image ? 2 : 1);
  state.tokens.push({ kind: "bracket", image, start, active: true });
  state.i = start;
  return true;
}

function findOpenBracket(tokens: Token[]): OpenBracket | null {
  for (let index = tokens.length - 1; index >= 0; index--) {
    const bracket = tokens[index];
    if (bracket?.kind === "bracket") return { index, bracket };
  }
  return null;
}

function resolveReference(state: InlineScan, label: string): LinkTarget | null {
  const after = state.i + 1;
  const reference = /^\[([^\]]*)\]/.exec(state.src.slice(after));
  if (reference) {
    const url = state.references.get(normalizeLabel(reference[1] || label));
    return url === undefined ? null : { url, end: after + reference[0].length };
  }
  const url = state.references.get(normalizeLabel(label));
  return url === undefined ? null : { url, end: after };
}

function resolveLinkTarget(state: InlineScan, bracket: Bracket): LinkTarget | null {
  if (state.src[state.i + 1] === "(") {
    const tail = parseLinkTail(state.src, state.i + 2);
    if (tail) return tail;
  }
  return resolveReference(state, state.src.slice(bracket.start, state.i));
}

function closeLink(state: InlineScan, { index, bracket }: OpenBracket, target: LinkTarget): void {
  const children = processEmphasis(state.tokens.slice(index + 1), false);
  const node: Inline = bracket.image
    ? { kind: "image", url: target.url, alt: plainText(children) }
    : { kind: "link", url: target.url, children };
  state.tokens.splice(index, state.tokens.length - index, node);
  if (!bracket.image) {
    for (const token of state.tokens) if (token.kind === "bracket" && !token.image) token.active = false;
  }
  state.i = target.end;
}

function rejectBracket(state: InlineScan, { index, bracket }: OpenBracket): void {
  state.tokens.splice(index, 1, { kind: "text", text: bracket.image ? "![" : "[" });
  pushText(state.tokens, "]");
  state.i++;
}

function scanBracketClose(state: InlineScan): boolean {
  if (state.src[state.i] !== "]") return false;
  flushText(state);
  const opener = findOpenBracket(state.tokens);
  if (!opener) {
    pushText(state.tokens, "]");
    state.i++;
    return true;
  }
  const target = opener.bracket.active ? resolveLinkTarget(state, opener.bracket) : null;
  if (target) closeLink(state, opener, target);
  else if (opener.bracket.active && state.streaming && /^\((?:[^)\s]*)$/.test(state.src.slice(state.i + 1))) {
    // A link still streaming its destination shows its text only.
    const children = processEmphasis(state.tokens.slice(opener.index + 1), false);
    state.tokens.splice(opener.index, state.tokens.length - opener.index, ...children);
    state.i = state.src.length;
  } else rejectBracket(state, opener);
  return true;
}

function scanAutolink(state: InlineScan): boolean {
  if (state.src[state.i] !== "<") return false;
  const rest = state.src.slice(state.i);
  const auto = AUTOLINK.exec(rest);
  const email = auto ? null : EMAIL_AUTOLINK.exec(rest);
  const match = auto ?? email;
  if (!match) return false;
  const target = requiredGroup(match, 1);
  flushText(state);
  state.tokens.push({
    kind: "link",
    url: email ? `mailto:${target}` : target,
    children: [{ kind: "text", text: target }],
  });
  state.i += match[0].length;
  return true;
}

function decodeEntity(entity: RegExpExecArray): string | null {
  const [, decimal, hex, name] = entity;
  if (name) return ENTITIES[name] ?? null;
  const code = decimal ? Number(decimal) : parseInt(hex, 16);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
}

function scanEntity(state: InlineScan): boolean {
  if (state.src[state.i] !== "&") return false;
  const entity = ENTITY.exec(state.src.slice(state.i));
  const decoded = entity ? decodeEntity(entity) : null;
  if (!entity || decoded === null) return false;
  state.text += decoded;
  state.i += entity[0].length;
  return true;
}

const INLINE_SCANNERS: ((state: InlineScan) => boolean)[] = [
  scanBackslash,
  scanLineBreak,
  scanCodeSpan,
  scanDelimiterRun,
  scanBracketOpen,
  scanBracketClose,
  scanAutolink,
  scanEntity,
];

export function parseInline(
  source: string,
  options: ParseOptions = {},
  references: References = new Map(),
): Inline[] {
  const state: InlineScan = {
    src: source,
    streaming: options.streaming === true,
    references,
    tokens: [],
    i: 0,
    text: "",
  };
  while (state.i < source.length) {
    if (INLINE_SCANNERS.some((scan) => scan(state))) continue;
    state.text += source.charAt(state.i);
    state.i++;
  }
  flushText(state);
  const inlines = processEmphasis(state.tokens, state.streaming);
  return references.linkify === false || options.linkify === false ? inlines : linkify(inlines);
}
