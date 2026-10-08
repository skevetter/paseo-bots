/** Browsers cut long utterances short, so readings go out in pieces of about this many characters. */
const CHUNK_CHARS = 220;

export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~|#]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function speechChunks(markdown: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const sentence of speakableText(markdown).split(/(?<=[.!?])\s+/)) {
    if (current && current.length + sentence.length + 1 > CHUNK_CHARS) {
      chunks.push(current);
      current = sentence;
    } else current = current ? `${current} ${sentence}` : sentence;
  }
  if (current) chunks.push(current);
  return chunks;
}
