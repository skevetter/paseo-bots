// Markdown for chat replies. The plugin SDK has no markdown component, so this
// is a small CommonMark + GFM parser shaped after what Paseo's markdown-it setup
// renders (utils/assistant-markdown-parser.ts): html off, linkify on, tables and
// strikethrough on, soft line breaks kept as line breaks (message.tsx softbreak).

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "italic"; children: Inline[] }
  | { kind: "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; url: string; children: Inline[] }
  | { kind: "image"; url: string; alt: string }
  | { kind: "break" };

export interface ListItem {
  marker: string;
  blocks: Block[];
}

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { kind: "paragraph"; inlines: Inline[] }
  | { kind: "heading"; level: number; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] }
  | { kind: "code"; language: string; text: string }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "table"; align: TableAlign[]; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

export interface ParseOptions {
  /** The text is still streaming: complete unclosed inline marks at its end, like Paseo's streaming parser. */
  streaming?: boolean;
  /** Turn bare URLs into links (on for chat, off for plan cards, as in Paseo). Default true. */
  linkify?: boolean;
}

/** Link reference definitions, plus whether bare URLs become links. */
type References = Map<string, string> & { linkify?: boolean };

// ---------------------------------------------------------------- inline

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

interface Delim {
  kind: "delim";
  char: "*" | "_" | "~";
  count: number;
  original: number;
  canOpen: boolean;
  canClose: boolean;
}

interface Bracket {
  kind: "bracket";
  image: boolean;
  /** Source index just after the opening "[". */
  start: number;
  active: boolean;
}

type Token = Inline | Delim | Bracket;

const isSpace = (char: string | undefined) => char === undefined || /\s/.test(char);
const isPunct = (char: string | undefined) => char !== undefined && PUNCTUATION.test(char);

function requiredGroup(match: RegExpExecArray, index: number): string {
  const value = match[index];
  if (value === undefined) throw new Error(`Markdown pattern matched without group ${index}: ${match[0]}`);
  return value;
}

function pushText(tokens: Token[], text: string): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last?.kind === "text") last.text += text;
  else tokens.push({ kind: "text", text });
}

function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, " ").toLowerCase();
}

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

function skipLinkWhitespace(src: string, start: number): number {
  let i = start;
  while (i < src.length && /[ \t\n]/.test(src.charAt(i))) i++;
  return i;
}

interface LinkTarget {
  url: string;
  end: number;
}

/** Link destination and optional title after "](" ... ")". Returns the url and the index after ")". */
function parseLinkTail(src: string, start: number): LinkTarget | null {
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

function emphasisKind(char: Delim["char"], use: number): "strike" | "bold" | "italic" {
  if (char === "~") return "strike";
  return use === 2 ? "bold" : "italic";
}

/** CommonMark's "process emphasis" over a token run; leftover delimiters become text. */
function processEmphasis(tokens: Token[], streaming: boolean): Inline[] {
  let i = 0;
  while (i < tokens.length) i = matchEmphasisAt(tokens, i);
  // Paseo's streaming parser closes emphasis the model hasn't closed yet.
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

const AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\s]*)>/;
const EMAIL_AUTOLINK =
  /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const BARE_URL = /(?:https?:\/\/|www\.)[^\s<]*[^\s<.,:;"')\]!?*_~]/g;
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z][a-zA-Z0-9]{1,31}));/;

/** markdown-it's linkify for http(s) and www. links in plain text. */
function linkify(inlines: Inline[]): Inline[] {
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
    // Unclosed code at the streaming tail renders as code (streaming-markdown completeCode).
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

// ---------------------------------------------------------------- blocks

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/;
const REFERENCE = /^ {0,3}\[([^\]]+)\]:[ \t]*<?([^\s>]+)>?(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function indentOf(line: string): number {
  let width = 0;
  for (const char of line) {
    if (char === " ") width++;
    else if (char === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}

/** Removes `width` columns of leading indentation. */
function stripIndent(line: string, width: number): string {
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

function popTrailingBlanks(lines: string[], minimum: number): number {
  let popped = 0;
  while (lines.length > minimum && !lines.at(-1)?.trim()) {
    lines.pop();
    popped++;
  }
  return popped;
}

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

function matchTableStart(lines: string[], i: number): { header: string[]; delimiter: string[] } | null {
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

/** Whether a line starts a block that ends (interrupts) a paragraph. */
function interruptsParagraph(line: string): boolean {
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

function matchFenceOpen(line: string): FenceOpen | null {
  const fence = FENCE_OPEN.exec(line);
  if (!fence) return null;
  const marker = requiredGroup(fence, 2);
  const info = requiredGroup(fence, 3);
  if (marker.startsWith("`") && info.includes("`")) return null;
  return { indent: requiredGroup(fence, 1).length, marker, info };
}

function fenceCloser(marker: string): RegExp {
  return new RegExp(`^ {0,3}${marker.startsWith("`") ? "`" : "~"}{${marker.length},}[ \\t]*$`);
}

function collectReferences(lines: string[], references: References): void {
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

interface BlockScan {
  lines: string[];
  tail: boolean;
  references: References;
  blocks: Block[];
  paragraph: string[];
  i: number;
}

function flushParagraph(state: BlockScan, streaming = false): void {
  if (state.paragraph.length === 0) return;
  const content = state.paragraph
    .join("\n")
    .replace(/^[ \t]+/, "")
    .replace(/[ \t]+$/, "");
  state.paragraph = [];
  if (content)
    state.blocks.push({ kind: "paragraph", inlines: parseInline(content, { streaming }, state.references) });
}

function takeLinesWhile(state: BlockScan, keep: (line: string) => boolean): string[] {
  const taken: string[] = [];
  for (let line = state.lines[state.i]; line !== undefined && keep(line); line = state.lines[state.i]) {
    taken.push(line);
    state.i++;
  }
  return taken;
}

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

function cellAlign(cell: string): TableAlign {
  const left = cell.startsWith(":");
  const right = cell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return left ? "left" : null;
}

function scanTable(state: BlockScan): boolean {
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

function scanReferenceDefinition(state: BlockScan, line: string): boolean {
  if (state.paragraph.length > 0 || !REFERENCE.test(line)) return false;
  state.i++;
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

function listKind(marker: string): ListKind {
  const ordered = /\d/.test(marker);
  return {
    ordered,
    delimiter: ordered ? marker.slice(-1) : marker,
    start: ordered ? parseInt(marker, 10) : 1,
  };
}

function matchNextListItem(line: string | undefined, kind: ListKind): RegExpExecArray | null {
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

function collectListItem(state: BlockScan, match: RegExpExecArray): ListItemDraft {
  const item = startListItem(match);
  state.i++;
  let line = state.lines[state.i];
  while (line !== undefined && extendListItem(state, item, line)) {
    state.i++;
    line = state.lines[state.i];
  }
  return item;
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

// ---------------------------------------------------------------- limits

/** Paseo caps what it renders of one assistant message (assistant-message-render-limit.ts). */
const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export function capMessageForRender(message: string): { text: string; capped: boolean } {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) return { text: message, capped: false };
  let end = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  const code = message.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: message.slice(0, end), capped: true };
}

export function utf8ByteLength(message: string): number {
  let bytes = 0;
  for (let index = 0; index < message.length; index += 1) {
    const code = message.charCodeAt(index);
    const next = message.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else bytes += 3;
  }
  return bytes;
}

// ---------------------------------------------------------------- time

/**
 * Paseo's duration format (utils/time.ts formatDuration): whole seconds under a
 * minute, then "2m 12s" / "2m", then "1h 5m" / "1h". Always floors.
 */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0s";
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${Math.floor(totalSeconds)}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    const seconds = Math.floor(totalSeconds) % 60;
    return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function calendarDaysBetween(earlier: Date, later: Date): number {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return Math.round((startOfDay(later).getTime() - startOfDay(earlier).getTime()) / 86_400_000);
}

let timeFormatter: Intl.DateTimeFormat | null = null;

/**
 * Paseo's hover timestamp (utils/time.ts formatMessageTimestamp): the time today,
 * "Wednesday 10:11 PM" within the week, "14 May 2026, 10:11 PM" before that.
 */
export function formatMessageTimestamp(date: Date, now: Date = new Date()): string {
  if (!timeFormatter) {
    const resolved = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).resolvedOptions();
    timeFormatter = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
      hourCycle: resolved.hourCycle,
    });
  }
  const time = timeFormatter.format(date);
  const daysAgo = calendarDaysBetween(date, now);
  if (daysAgo === 0) return time;
  if (daysAgo > 0 && daysAgo < 7) return `${date.toLocaleDateString(undefined, { weekday: "long" })} ${time}`;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${time}`;
}
