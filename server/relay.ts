import { createHmac, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AppLimit, checkAppCall } from "../shared/apps";
import type { AppRule, Bot, McpServerConfig } from "../shared/bot";
import { accounts, appTools, connectedSlugs, deadline, readState, session, writeState } from "./composio";
import type { BotsHost } from "./host";
import { answerMcp, type BotTool } from "./tools/mcp";

// Loopback MCP servers on 127.0.0.1; each chat gets a bearer token in its config, signed with a secret
// only this process knows.

const MAX_BODY = 5 * 1024 * 1024;
const MAX_RESPONSE = 20 * 1024 * 1024;
const DISCARD_MS = 2_000;
const ID = /^[a-z0-9-]+$/;

function sign(secret: string, subject: string): string {
  return createHmac("sha256", secret).update(subject).digest("hex");
}

/** Must stay stable so running chats' tokens keep working. */
function botToken(secret: string, botId: string): string {
  return sign(secret, botId);
}

function toolsToken(secret: string, botId: string, agentId: string): string {
  return sign(secret, `tools:${botId}:${agentId}`);
}

function tokenMatches(expected: string, header: string | undefined): boolean {
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

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
}

/** Returns true when it handled the request. */
export type RelayRoute = (
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
) => Promise<boolean>;

async function appLimits(bot: Bot): Promise<Map<string, AppLimit>> {
  const limits = new Map<string, AppLimit>();
  for (const slug of bot.apps) {
    const rule = bot.appRules[slug];
    if (!rule || (rule.tools === "all" && !rule.account)) continue;
    const tools = await allowedTools(slug, rule.tools);
    limits.set(slug, {
      tools: tools && new Set(tools.map((tool) => tool.toUpperCase())),
      account: await accountLimit(rule.account),
    });
  }
  return limits;
}

async function allowedTools(slug: string, tools: AppRule["tools"]): Promise<string[] | null> {
  if (tools === "all") return null;
  if (tools !== "read") return tools;
  return (await appTools({ slug })).tools.filter((tool) => tool.readOnly).map((tool) => tool.slug);
}

async function accountLimit(accountId: string | null): Promise<AppLimit["account"]> {
  if (!accountId) return null;
  const alias = (await accounts()).accounts.find((account) => account.id === accountId)?.alias ?? null;
  return { id: accountId, alias };
}

async function readCapped(upstream: Response, limit: number): Promise<Buffer> {
  const tooLarge = new Error(`The connected app's answer is over ${limit / 1024 / 1024} MB.`);
  if (Number(upstream.headers.get("content-length")) > limit) {
    await upstream.body?.cancel();
    throw tooLarge;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of upstream.body ?? []) {
    size += chunk.length;
    if (size > limit) throw tooLarge;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export class Relay {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private starts = 0;
  private readonly routes: RelayRoute[] = [];

  constructor(
    private readonly host: BotsHost,
    private readonly tools: readonly BotTool[],
  ) {}

  addRoute(route: RelayRoute): void {
    this.routes.push(route);
  }

  /** Reuses the previous port when it's free so running chats keep their URLs. */
  start(): Promise<number> {
    this.listening ??= this.open(this.starts);
    return this.listening;
  }

  private async open(start: number): Promise<number> {
    const state = await readState();
    const server = createServer((request, response) => void this.handle(request, response));
    const listen = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          const address = server.address();
          resolve(address && typeof address === "object" ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await listen(state.port ?? 0);
    } catch {
      port = await listen(0);
    }
    if (start !== this.starts) {
      server.close();
      throw new Error("The relay stopped before it started listening.");
    }
    this.server = server;
    server.on("error", (error) => console.error("paseo-bots: the relay's server failed", error));
    if (port !== state.port) await writeState({ port });
    return port;
  }

  /** Resolves once the server has closed; requests still open are cut off. */
  async stop(): Promise<void> {
    this.starts++;
    const { server, listening } = this;
    this.server = null;
    this.listening = null;
    await listening?.catch(() => {});
    if (!server) return;
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  }

  async mountApps(botId: string): Promise<McpServerConfig | null> {
    const state = await readState();
    if (!state.apiKey) return null;
    const port = await this.start();
    return {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp/${botId}`,
      headers: { Authorization: `Bearer ${botToken(state.secret, botId)}` },
    };
  }

  async mountTools(botId: string, agentId: string): Promise<McpServerConfig> {
    const state = await readState();
    const port = await this.start();
    return {
      type: "http",
      url: `http://127.0.0.1:${port}/bots/${botId}/${agentId}`,
      headers: { Authorization: `Bearer ${toolsToken(state.secret, botId, agentId)}` },
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      await this.dispatch(request, response);
    } catch (error) {
      if (response.headersSent || response.destroyed) response.destroy();
      else
        json(response, 502, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32002, message: error instanceof Error ? error.message : String(error) },
        });
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? "").split("?")[0] ?? "";
    const apps = /^\/mcp\/([^/]+)$/.exec(path);
    if (apps) {
      const [, botId] = apps;
      return await this.handleApps(request, response, botId);
    }
    const tools = /^\/bots\/([^/]+)\/([^/]+)$/.exec(path);
    if (tools) {
      const [, botId, agentId] = tools;
      return await this.handleTools(request, response, botId, agentId);
    }
    for (const route of this.routes) if (await route(request, response, path)) return;
    json(response, 404, { error: "not found" });
  }

  /** Streamable HTTP lets a server decline the optional GET stream; sessions end on their own. */
  private refuseNonPost(request: IncomingMessage, response: ServerResponse): boolean {
    if (request.method === "POST") return false;
    if (request.method === "DELETE") response.writeHead(204).end();
    else response.writeHead(405, { allow: "POST" }).end();
    return true;
  }

  private async parse(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<{ body: string; message: Record<string, unknown> } | null> {
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
    if (!message || typeof message !== "object") {
      json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      return null;
    }
    return { body, message: message as Record<string, unknown> };
  }

  private async handleTools(
    request: IncomingMessage,
    response: ServerResponse,
    botId: string,
    agentId: string,
  ) {
    const state = await readState();
    if (
      !ID.test(botId) ||
      !ID.test(agentId) ||
      !tokenMatches(toolsToken(state.secret, botId, agentId), request.headers.authorization)
    ) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived)
      return json(response, 403, {
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "This bot no longer exists." },
      });
    const answer = await answerMcp(parsed.message, this.tools, {
      bot,
      agentId,
      host: this.host,
      relay: this,
    });
    if (!answer) return response.writeHead(202).end();
    json(response, 200, answer);
  }

  private async handleApps(request: IncomingMessage, response: ServerResponse, botId: string) {
    const state = await readState();
    if (!ID.test(botId) || !tokenMatches(botToken(state.secret, botId), request.headers.authorization)) {
      return json(response, 401, { error: "unauthorized" });
    }
    if (this.refuseNonPost(request, response)) return;
    const parsed = await this.parse(request, response);
    if (!parsed) return;
    const bot = await this.host.bot(botId);
    const id = (parsed.message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived || bot.hostId || bot.apps.length === 0) {
      return json(response, 403, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: "Connected apps are off for this bot. Turn them on under its Access settings in Paseo.",
        },
      });
    }
    // Limits need Composio's tool lists, so they're looked up for tool calls only.
    const limits =
      parsed.message.method === "tools/call" ? await appLimits(bot) : new Map<string, AppLimit>();
    const verdict = checkAppCall(parsed.message, {
      allowed: bot.apps,
      connected: await connectedSlugs(),
      limits,
    });
    if ("refusal" in verdict)
      return json(response, 200, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: verdict.refusal }], isError: true },
      });
    await this.forward(
      request,
      response,
      verdict.message === parsed.message ? parsed.body : JSON.stringify(verdict.message),
    );
  }

  private async forward(request: IncomingMessage, response: ServerResponse, body: string) {
    const transport = request.headers["mcp-session-id"];
    const send = async (recreate: boolean) => {
      const upstream = await session({ recreate });
      return fetch(upstream.mcpUrl, {
        method: "POST",
        headers: {
          "x-api-key": upstream.apiKey,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(typeof transport === "string" ? { "mcp-session-id": transport } : {}),
          ...(typeof request.headers["mcp-protocol-version"] === "string"
            ? { "mcp-protocol-version": request.headers["mcp-protocol-version"] }
            : {}),
        },
        body,
        signal: deadline(10 * 60_000),
      });
    };
    let upstream = await send(false);
    // A Tool Router session Composio no longer knows: open a new one and let the client start over.
    if (upstream.status === 404 && !transport) {
      await upstream.body?.cancel();
      upstream = await send(true);
    }
    const bytes = await readCapped(upstream, MAX_RESPONSE);
    const next = upstream.headers.get("mcp-session-id");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(next ? { "mcp-session-id": next } : {}),
    });
    response.end(bytes);
  }
}
