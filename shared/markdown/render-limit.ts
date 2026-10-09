/** Must match Paseo's cap (assistant-message-render-limit.ts). */
const ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT = 32_000;

export function capMessageForRender(message: string): { text: string; capped: boolean } {
  if (message.length <= ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT) return { text: message, capped: false };
  let end = ASSISTANT_MESSAGE_RENDER_CHARACTER_LIMIT;
  const code = message.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: message.slice(0, end), capped: true };
}
