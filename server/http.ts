/** Stops reading, and rejects with `tooLarge`, once the declared or received size passes `limit` bytes. */
export async function readCapped(response: Response, limit: number, tooLarge: Error): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw tooLarge;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > limit) throw tooLarge;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
