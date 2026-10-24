import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { type AppLimit, checkAppCall } from "../shared/apps";
import type { AppRule, Bot, McpServerConfig } from "../shared/bot";
import type { PluginServers } from "../shared/bot-agent";
import type { FrozenRelayPermissions } from "../shared/chat";
import { accounts, appTools, connectedSlugs, deadline, readState, session, writeState } from "./composio";
import type { BotsHost } from "./host";
import { readCapped } from "./http";
import { publishLegacyRelayGrant, readLegacyRelayGrant } from "./legacy-relay-grants";
import { json, readMessage, refuseNonPost, tokenMatches } from "./mcp-http";
import { answerMcp, type BotTool } from "./tools/mcp";

// Loopback MCP servers on 127.0.0.1; each chat gets a bearer token in its config, signed with a secret
// only this process knows.

const MAX_RESPONSE = 20 * 1024 * 1024;
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

function creationRelayToken(
  secret: string,
  {
    botId,
    agentId,
    prepared,
    kind,
  }: {
    botId: string;
    agentId?: string;
    prepared: boolean;
    kind: "tools" | "apps";
  },
): string {
  const subject = kind === "tools" ? (prepared ? "prepared-tools" : "tools") : "apps";
  return agentId ? sign(secret, `${subject}:${botId}:${agentId}`) : botToken(secret, botId);
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

export class Relay {
  private server: Server | null = null;
  private listening: Promise<number> | null = null;
  private starts = 0;
  private closed = false;
  private readonly requireActive = () => {
    if (this.closed) throw new Error("The relay has been unloaded.");
  };
  private readonly routes: RelayRoute[] = [];
  private readonly preparedPermissions = new Map<
    string,
    {
      botId: string;
      permissions: FrozenRelayPermissions;
    }
  >();

  constructor(
    private readonly host: BotsHost,
    private readonly tools: readonly BotTool[],
  ) {}

  addRoute(route: RelayRoute): void {
    this.routes.push(route);
  }

  /** Reuses the previous port when it's free so running chats keep their URLs. A failed start can be retried. */
  start(): Promise<number> {
    if (this.closed) return Promise.reject(new Error("The relay has been unloaded."));
    if (!this.listening) {
      const listening = this.open(this.starts);
      this.listening = listening;
      listening.catch(() => {
        if (this.listening === listening) this.listening = null;
      });
    }
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

  /** Unload is terminal; ordinary stop remains restartable for recovery. */
  close(): Promise<void> {
    this.closed = true;
    this.preparedPermissions.clear();
    return this.stop();
  }

  async preparePermissions(bot: Bot): Promise<FrozenRelayPermissions> {
    const limits = await appLimits(bot);
    return {
      contactBots: bot.contactBots,
      apps: [...bot.apps],
      appLimits: Object.fromEntries(
        [...limits].map(([slug, limit]) => [
          slug,
          {
            tools: limit.tools ? [...limit.tools] : null,
            account: limit.account,
          },
        ]),
      ),
    };
  }

  /** Recovery refreshes endpoints and credentials, never the admitted authorization. */
  async mountPrepared(
    botId: string,
    agentId: string,
    frozen: { tools: boolean; apps: boolean; permissions: FrozenRelayPermissions },
    options: { durableLegacy?: boolean } = {},
  ): Promise<PluginServers> {
    this.requireActive();
    this.checkPreparedConflict(botId, agentId, frozen.permissions);
    if (options.durableLegacy) {
      await publishLegacyRelayGrant({ botId, agentId, frozen, permissions: frozen.permissions });
      this.requireActive();
      this.checkPreparedConflict(botId, agentId, frozen.permissions);
    }
    this.preparedPermissions.set(agentId, {
      botId,
      permissions: JSON.parse(JSON.stringify(frozen.permissions)) as FrozenRelayPermissions,
    });
    let apps: McpServerConfig | null = null;
    if (frozen.apps) {
      const state = await readState();
      if (!state.apiKey) throw new Error("The admitted connected-app relay is unavailable.");
      const port = await this.start();
      apps = {
        type: "http",
        url: `http://127.0.0.1:${port}/mcp/${botId}/${agentId}`,
        headers: { Authorization: `Bearer ${sign(state.secret, `apps:${botId}:${agentId}`)}` },
      };
    }
    let tools: McpServerConfig | null = null;
    if (frozen.tools) {
      const state = await readState();
      const port = await this.start();
      tools = {
        type: "http",
        url: `http://127.0.0.1:${port}/bots/${botId}/${agentId}/prepared`,
        headers: { Authorization: `Bearer ${sign(state.secret, `prepared-tools:${botId}:${agentId}`)}` },
      };
    }
    return {
      tools,
      apps,
    };
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
    const apps = /^\/mcp\/([^/]+)(?:\/([^/]+))?$/.exec(path);
    if (apps) {
      const [, botId, agentId] = apps;
      return await this.handleApps(request, response, botId, agentId);
    }
    const tools = /^\/bots\/([^/]+)\/([^/]+)(\/prepared)?$/.exec(path);
    if (tools) {
      const [, botId, agentId, prepared] = tools;
      return await this.handleTools(request, response, { botId, agentId, prepared: Boolean(prepared) });
    }
    for (const route of this.routes) if (await route(request, response, path)) return;
    json(response, 404, { error: "not found" });
  }

  private async relayAccess(
    request: IncomingMessage,
    identity: { botId: string; agentId?: string; prepared: boolean; kind: "tools" | "apps" },
  ): Promise<{ permissions: FrozenRelayPermissions | null } | null> {
    const { botId, agentId, prepared } = identity;
    if (!ID.test(botId) || (agentId && !ID.test(agentId))) return null;
    const state = await readState();
    const token = creationRelayToken(state.secret, identity);
    if (!tokenMatches(token, request.headers.authorization)) return null;
    if (!prepared) return { permissions: null };
    const admitted = agentId ? await this.admittedPrepared(botId, agentId) : null;
    return admitted ? { permissions: admitted.permissions } : null;
  }

  private checkPreparedConflict(botId: string, agentId: string, permissions: FrozenRelayPermissions): void {
    const previous = this.preparedPermissions.get(agentId);
    if (
      previous &&
      (previous.botId !== botId || JSON.stringify(previous.permissions) !== JSON.stringify(permissions))
    ) {
      throw new Error("Prepared relay identity has conflicting permissions.");
    }
  }

  /** Cold restore reads a receipt only after the bearer verified; the process map then caches it. */
  private async admittedPrepared(
    botId: string,
    agentId: string,
  ): Promise<{ botId: string; permissions: FrozenRelayPermissions } | null> {
    if (this.closed) return null;
    const known = this.preparedPermissions.get(agentId);
    if (known) return known.botId === botId ? known : null;
    const grant = await readLegacyRelayGrant(agentId);
    if (this.closed || !grant || grant.botId !== botId) return null;
    const current = this.preparedPermissions.get(agentId);
    if (current) return current.botId === botId ? current : null;
    const admitted = { botId, permissions: grant.permissions };
    this.preparedPermissions.set(agentId, admitted);
    return admitted;
  }

  private async handleTools(
    request: IncomingMessage,
    response: ServerResponse,
    identity: { botId: string; agentId: string; prepared: boolean },
  ) {
    const { botId, agentId } = identity;
    const access = await this.relayAccess(request, { ...identity, kind: "tools" });
    if (!access) return json(response, 401, { error: "unauthorized" });
    if (refuseNonPost(request, response)) return;
    const message = await readMessage(request, response);
    if (!message) return;
    const bot = await this.host.bot(botId);
    this.requireActive();
    const id = (message.id as string | number | undefined) ?? null;
    if (!bot || bot.archived)
      return json(response, 403, {
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "This bot no longer exists." },
      });
    const answer = await answerMcp(
      message,
      { name: "paseo-bots", tools: this.tools, beforeCall: this.requireActive },
      {
        bot: access.permissions ? { ...bot, contactBots: access.permissions.contactBots } : bot,
        agentId,
        host: this.host,
        relay: this,
      },
    );
    if (!answer) return response.writeHead(202).end();
    json(response, 200, answer);
  }

  private async handleApps(
    request: IncomingMessage,
    response: ServerResponse,
    botId: string,
    agentId?: string,
  ) {
    const access = await this.relayAccess(request, {
      botId,
      agentId,
      prepared: agentId !== undefined,
      kind: "apps",
    });
    if (!access) return json(response, 401, { error: "unauthorized" });
    if (refuseNonPost(request, response)) return;
    const message = await readMessage(request, response);
    if (!message) return;
    const bot = await this.host.bot(botId);
    const id = (message.id as string | number | undefined) ?? null;
    const allowed = access.permissions?.apps ?? bot?.apps ?? [];
    if (!bot || bot.archived || bot.hostId || allowed.length === 0) {
      return json(response, 403, {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: "Connected apps are off for this bot. Turn them on under its Access settings in Paseo.",
        },
      });
    }
    const limits = await this.admittedAppLimits(bot, access.permissions, message.method === "tools/call");
    const verdict = checkAppCall(message, {
      allowed,
      connected: await connectedSlugs(),
      limits,
    });
    if ("refusal" in verdict)
      return json(response, 200, {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: verdict.refusal }], isError: true },
      });
    // Re-encoded so Composio parses exactly what was checked (no duplicate keys read another way).
    this.requireActive();
    await this.forward(request, response, JSON.stringify(verdict.message));
  }

  private async admittedAppLimits(
    bot: Bot,
    frozen: FrozenRelayPermissions | null,
    toolCall: boolean,
  ): Promise<Map<string, AppLimit>> {
    if (!frozen) return toolCall ? appLimits(bot) : new Map<string, AppLimit>();
    return new Map(
      Object.entries(frozen.appLimits).map(([slug, limit]) => [
        slug,
        { tools: limit.tools ? new Set(limit.tools) : null, account: limit.account },
      ]),
    );
  }

  private async forward(request: IncomingMessage, response: ServerResponse, body: string) {
    const transport = request.headers["mcp-session-id"];
    const send = async (recreate: boolean) => {
      this.requireActive();
      const upstream = await session({ recreate });
      this.requireActive();
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
    const tooLarge = new Error(`The connected app's answer is over ${MAX_RESPONSE / 1024 / 1024} MB.`);
    const bytes = await readCapped(upstream, MAX_RESPONSE, tooLarge);
    const next = upstream.headers.get("mcp-session-id");
    response.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/json",
      ...(next ? { "mcp-session-id": next } : {}),
    });
    response.end(bytes);
  }
}
