import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY = 5 * 1024 * 1024;
const DISCARD_MS = 2_000;

export function tokenMatches(expected: string, header: string | undefined): boolean {
  const given = /^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "";
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`The request body is over ${limit} bytes.`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * Past `limit` the rest of the body is discarded, not buffered, until it ends (or for DISCARD_MS) so the
 * client is done sending and reads the 413 instead of a reset; then rejects with BodyTooLargeError.
 */
export function readBody(request: IncomingMessage, limit = MAX_BODY): Promise<string> {
  const tooLarge = new BodyTooLargeError(limit);
  if (Number(request.headers["content-length"]) > limit) return Promise.reject(tooLarge);
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks: Buffer[] | null = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (chunks && size > limit) {
        chunks = null;
        setTimeout(() => reject(tooLarge), DISCARD_MS).unref();
      }
      chunks?.push(chunk);
    });
    request.on("end", () => (chunks ? resolve(Buffer.concat(chunks).toString("utf8")) : reject(tooLarge)));
    request.on("error", reject);
    request.on("close", () => reject(new Error("The request closed before its body arrived.")));
  });
}

export function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Streamable HTTP lets a server decline the optional GET stream; sessions end on their own. */
export function refuseNonPost(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method === "POST") return false;
  if (request.method === "DELETE") response.writeHead(204).end();
  else response.writeHead(405, { allow: "POST" }).end();
  return true;
}

/** One message per request, as in MCP 2025-06-18: a batch would carry tool calls past the checks. Null once it answered a bad request. */
export async function readMessage(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | null> {
  const body = await readBody(request).catch((error: unknown) => {
    if (error instanceof BodyTooLargeError) return null;
    throw error;
  });
  if (body === null) {
    json(response, 413, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Send at most ${MAX_BODY / 1024 / 1024} MB.` },
    });
    return null;
  }
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return null;
  }
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    return null;
  }
  return message as Record<string, unknown>;
}
