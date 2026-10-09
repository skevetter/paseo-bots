/** Must match Paseo's cap (assistant-message-render-limit.ts). */
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
