import { once } from "node:events";
import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { createServer as createNetServer, Server, Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readState, writeState } from "../server/composio";
import { BodyTooLargeError, Relay, readBody } from "../server/relay";
import type { Bot, McpServerConfig } from "../shared/bot";
import { newUuid } from "../shared/uuid";
import { defined, fakeHost, makeBot, useTempPaseoHome } from "./helpers";

const MB = 1024 * 1024;
const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

interface Answer {
  status: number;
  body: string;
  complete: boolean;
}

/** Errors after the answer arrived (the relay closing on an unread body) are expected. */
function post(
  target: string,
  headers: OutgoingHttpHeaders,
  send: (request: ClientRequest) => void,
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(target, { method: "POST", headers, agent: false });
    request.on("error", reject);
    request.on("response", (response) => {
      request.off("error", reject).on("error", () => undefined);
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("close", () =>
        resolve({ status: response.statusCode ?? 0, body, complete: response.complete }),
      );
    });
    send(request);
  });
}

function httpMount(mount: McpServerConfig | null): { url: string; authorization: string } {
  if (mount?.type !== "http") throw new Error("Expected the relay to mount an http server");
  return { url: mount.url, authorization: defined(mount.headers?.Authorization, "Authorization header") };
}

function hangUpMidBody(target: string, started: Promise<void>): void {
  const request = httpRequest(target, {
    method: "POST",
    headers: { "content-length": "1000" },
    agent: false,
  });
  request.on("error", () => undefined);
  request.write("partial");
  void started.then(() => request.destroy());
}

describe("the relay's request bodies", () => {
  useTempPaseoHome("paseo-bots-relay-");

  it("answers 413 to a declared oversized body without waiting for it", async () => {
    const relay = new Relay(fakeHost([makeBot({ id: "bot-a" })]), []);
    try {
      const { url, authorization } = httpMount(await relay.mountTools("bot-a", newUuid()));
      const answer = await post(url, { authorization, "content-length": String(10 * MB) }, (request) =>
        request.flushHeaders(),
      );
      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body)).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 } });
    } finally {
      relay.stop();
    }
  });

  it("answers 413 once a chunked body runs past the limit", async () => {
    const relay = new Relay(fakeHost([makeBot({ id: "bot-a" })]), []);
    try {
      const { url, authorization } = httpMount(await relay.mountTools("bot-a", newUuid()));
      const chunked = { authorization, "transfer-encoding": "chunked" };
      const answer = await post(url, chunked, (request) => request.end(Buffer.alloc(6 * MB, "x")));
      expect(answer.status).toBe(413);
      expect(answer.body).toContain("Send at most 5 MB.");
    } finally {
      relay.stop();
    }
  });

  it("stops reading a body whose sender hung up", async () => {
    const relay = new Relay(fakeHost([makeBot({ id: "bot-a" })]), []);
    let reading: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    let settle: (outcome: string) => void = () => undefined;
    const outcome = new Promise<string>((resolve) => {
      settle = resolve;
    });
    relay.addRoute(async (request, response, path) => {
      if (path !== "/upload") return false;
      reading();
      settle(
        await readBody(request).then(
          () => "read",
          (error: unknown) => (error instanceof BodyTooLargeError ? "too large" : "closed"),
        ),
      );
      response.end();
      return true;
    });
    try {
      hangUpMidBody(`http://127.0.0.1:${await relay.start()}/upload`, started);
      expect(await outcome).toBe("closed");
    } finally {
      relay.stop();
    }
  });

  it("tells a route a too-large body apart from other failures", async () => {
    const relay = new Relay(fakeHost([]), []);
    relay.addRoute(async (request, response, path) => {
      if (path !== "/hook") return false;
      const failure = await readBody(request, 16).then(
        () => null,
        (error: unknown) => error,
      );
      response.writeHead(failure instanceof BodyTooLargeError ? 413 : 200).end();
      return true;
    });
    try {
      const target = `http://127.0.0.1:${await relay.start()}/hook`;
      expect((await post(target, {}, (request) => request.end("small"))).status).toBe(200);
      const chunked = { "transfer-encoding": "chunked" };
      expect((await post(target, chunked, (request) => request.end("x".repeat(64)))).status).toBe(413);
    } finally {
      relay.stop();
    }
  });

  it("gives up on an oversized body that never ends after a grace period", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const request = new IncomingMessage(new Socket());
    try {
      const outcome = { value: "pending" };
      const reading = readBody(request, 4).then(
        () => "read",
        (error: unknown) => (error instanceof BodyTooLargeError ? "too large" : "failed"),
      );
      void reading.then((value) => {
        outcome.value = value;
      });
      request.push("more than four bytes");
      await nextTurn();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(outcome.value).toBe("pending");
      await vi.advanceTimersByTimeAsync(1);
      expect(await reading).toBe("too large");
    } finally {
      request.destroy();
      vi.useRealTimers();
    }
  });
});

describe("the relay's own failures", () => {
  useTempPaseoHome("paseo-bots-relay-failures-");

  it("logs an error of its server instead of crashing", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const relay = new Relay(fakeHost([]), []);
    try {
      const port = await relay.start();
      const server = listen.mock.contexts.at(-1);
      if (!(server instanceof Server)) throw new Error("Expected the relay to listen");
      expect(() => server.emit("error", new Error("EMFILE: too many open files"))).not.toThrow();
      expect(logged).toHaveBeenCalledWith(expect.stringContaining("relay"), expect.any(Error));
      expect((await post(`http://127.0.0.1:${port}/nowhere`, {}, (request) => request.end())).status).toBe(
        404,
      );
    } finally {
      relay.stop();
      listen.mockRestore();
      logged.mockRestore();
    }
  });

  it("cuts off an answer that failed after it started", async () => {
    const relay = new Relay(fakeHost([]), []);
    relay.addRoute(async (_request, response, path) => {
      if (path !== "/half") return false;
      response.writeHead(200, { "content-type": "text/plain" });
      await new Promise<void>((resolve) => response.write("partial", () => resolve()));
      throw new Error("lost the upstream");
    });
    try {
      const answer = await post(`http://127.0.0.1:${await relay.start()}/half`, {}, (request) =>
        request.end(),
      );
      expect(answer).toMatchObject({ status: 200, body: "partial", complete: false });
    } finally {
      relay.stop();
    }
  });

  it("answers 502 with whatever a route threw", async () => {
    const relay = new Relay(fakeHost([]), []);
    relay.addRoute(async (_request, _response, path) => {
      if (path !== "/odd") return false;
      throw "no upstream";
    });
    try {
      const answer = await post(`http://127.0.0.1:${await relay.start()}/odd`, {}, (request) =>
        request.end(),
      );
      expect(answer.status).toBe(502);
      expect(JSON.parse(answer.body)).toMatchObject({ error: { code: -32002, message: "no upstream" } });
    } finally {
      relay.stop();
    }
  });
});

describe("the relay's lifecycle", () => {
  useTempPaseoHome("paseo-bots-relay-lifecycle-");

  it("closes the server it was still starting when it's stopped", async () => {
    const listen = vi.spyOn(Server.prototype, "listen");
    const relay = new Relay(fakeHost([]), []);
    try {
      const starting = relay.start();
      relay.stop();
      await expect(starting).rejects.toThrow("stopped");
      const server = listen.mock.contexts.at(-1);
      if (!(server instanceof Server)) throw new Error("Expected the relay to listen");
      expect(server.listening).toBe(false);
      const port = await relay.start();
      expect((await post(`http://127.0.0.1:${port}/nowhere`, {}, (request) => request.end())).status).toBe(
        404,
      );
    } finally {
      relay.stop();
      listen.mockRestore();
    }
  });

  it("comes back on the same port after a restart", async () => {
    const relay = new Relay(fakeHost([]), []);
    try {
      const port = await relay.start();
      relay.stop();
      expect(await relay.start()).toBe(port);
      expect((await readState()).port).toBe(port);
    } finally {
      relay.stop();
    }
  });

  it("moves to a free port and remembers it when its last one is taken", async () => {
    const squatter = createNetServer();
    squatter.listen(0, "127.0.0.1");
    await once(squatter, "listening");
    const address = squatter.address();
    if (!address || typeof address === "string") throw new Error("Expected the squatter to listen");
    await writeState({ port: address.port });
    const relay = new Relay(fakeHost([]), []);
    try {
      const port = await relay.start();
      expect(port).not.toBe(address.port);
      expect((await readState()).port).toBe(port);
      expect((await post(`http://127.0.0.1:${port}/nowhere`, {}, (request) => request.end())).status).toBe(
        404,
      );
    } finally {
      relay.stop();
      squatter.close();
    }
  });

  it("mounts no connected apps until a Composio key is added", async () => {
    await writeState({ apiKey: null });
    const relay = new Relay(fakeHost([makeBot({ id: "bot-a", apps: ["gmail"] })]), []);
    try {
      expect(await relay.mountApps("bot-a")).toBeNull();
    } finally {
      relay.stop();
    }
  });
});

describe("the relay's bot tools endpoint", () => {
  useTempPaseoHome("paseo-bots-relay-tools-");
  const relay = new Relay(
    fakeHost([makeBot({ id: "bot-a" }), makeBot({ id: "bot-old", archived: true })]),
    [],
  );
  afterAll(() => relay.stop());
  const mount = async (botId = "bot-a", agentId = newUuid()) =>
    httpMount(await relay.mountTools(botId, agentId));
  const call = (target: string, authorization: string, body: string) =>
    post(target, { authorization, "content-type": "application/json" }, (request) => request.end(body));
  const statusFor = async (target: string, headers: OutgoingHttpHeaders) =>
    (await post(target, headers, (request) => request.end(INITIALIZE))).status;

  it("answers only the chat its token was minted for", async () => {
    const { url, authorization } = await mount();
    const other = await mount();
    expect(await statusFor(url, {})).toBe(401);
    expect(await statusFor(url, { authorization: authorization.replace("Bearer", "Token") })).toBe(401);
    expect(await statusFor(url, { authorization: other.authorization })).toBe(401);
    expect(await statusFor(url, { authorization })).toBe(200);
  });

  it("refuses ids outside lower-case letters, digits and dashes even with their own token", async () => {
    for (const odd of [await mount("Bot_A"), await mount("bot-a", "Agent_1")]) {
      expect(await statusFor(odd.url, { authorization: odd.authorization })).toBe(401);
    }
  });

  it("declines the optional GET stream and lets a session end", async () => {
    const { url, authorization } = await mount();
    const stream = await fetch(url, { headers: { authorization } });
    expect(stream.status).toBe(405);
    expect(stream.headers.get("allow")).toBe("POST");
    expect((await fetch(url, { method: "DELETE", headers: { authorization } })).status).toBe(204);
  });

  it("answers a parse error to a body that isn't JSON", async () => {
    const { url, authorization } = await mount();
    const answer = await call(url, authorization, "{");
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body)).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("tells a chat its bot was archived or deleted", async () => {
    for (const botId of ["bot-old", "bot-gone"]) {
      const { url, authorization } = await mount(botId);
      const answer = await call(
        url,
        authorization,
        JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      );
      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body)).toMatchObject({ id: 7, error: { code: -32001 } });
    }
  });

  it("keeps answering after a chat hangs up mid-request", async () => {
    const listeners = vi.spyOn(IncomingMessage.prototype, "on");
    try {
      const { url, authorization } = await mount();
      const headers = { authorization, "content-length": "1000" };
      const request = httpRequest(url, { method: "POST", headers, agent: false });
      request.on("error", () => undefined);
      request.write("{");
      await vi.waitFor(() => expect(listeners).toHaveBeenCalledWith("close", expect.any(Function)));
      request.destroy();
      expect(await statusFor(url, { authorization })).toBe(200);
    } finally {
      listeners.mockRestore();
    }
  });

  it("refuses a body that isn't a JSON-RPC message", async () => {
    const { url, authorization } = await mount();
    for (const body of ["null", "42"]) {
      const answer = await call(url, authorization, body);
      expect(answer.status).toBe(400);
      expect(JSON.parse(answer.body)).toMatchObject({ jsonrpc: "2.0", id: null, error: { code: -32600 } });
    }
  });
});

function pour(response: ServerResponse, sent: { bytes: number }): void {
  const chunk = Buffer.alloc(MB, "x");
  const next = () => {
    while (sent.bytes < 64 * MB && !response.destroyed) {
      sent.bytes += chunk.length;
      if (!response.write(chunk)) return void response.once("drain", next);
    }
    response.end();
  };
  response.writeHead(200, { "content-type": "application/json" });
  next();
}

describe("the relay's answers from connected apps", () => {
  useTempPaseoHome("paseo-bots-relay-apps-");
  const sent = { bytes: 0 };
  let forgottenClosed = false;
  const answers: Record<string, (response: ServerResponse) => void> = {
    "/mcp/declared": (response) => {
      response.writeHead(200, { "content-type": "application/json", "content-length": String(30 * MB) });
      response.write("{");
    },
    "/mcp/endless": (response) => pour(response, sent),
    "/mcp/forgotten": (response) => {
      response.on("close", () => {
        forgottenClosed = true;
      });
      response.writeHead(404, { "content-type": "application/json" }).write('{"error": "no such session"');
    },
    "/api/v3.1/tool_router/session": (response) =>
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ session_id: "trs_2", mcp: { type: "http", url: `${origin}/mcp/fresh` } })),
    "/mcp/fresh": (response) =>
      response.writeHead(200, { "content-type": "application/json" }).end('{"jsonrpc": "2.0", "id": 1}'),
  };
  const upstream = createServer((request, response) => {
    const answer = answers[request.url ?? ""];
    if (answer) answer(response);
    else response.writeHead(404).end();
  });
  let origin = "";

  beforeAll(async () => {
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Expected the fake upstream to listen");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = origin;
  });

  afterAll(() => {
    delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
    upstream.closeAllConnections();
    upstream.close();
  });

  const ask = async (route: string) => {
    await writeState({
      apiKey: "ak_test",
      sessionId: "trs_1",
      mcpUrl: `${origin}${route}`,
      multiAccount: true,
    });
    const relay = new Relay(fakeHost([makeBot({ id: "bot-1", apps: ["gmail"] })]), []);
    try {
      const { url, authorization } = httpMount(await relay.mountApps("bot-1"));
      const message = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      return await post(url, { authorization, "content-type": "application/json" }, (request) =>
        request.end(message),
      );
    } finally {
      relay.stop();
    }
  };

  it("refuses an answer declared over 20 MB without waiting for it", async () => {
    const answer = await ask("/mcp/declared");
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("over 20 MB");
  });

  it("stops reading an answer once it runs past 20 MB", async () => {
    const answer = await ask("/mcp/endless");
    expect(answer.status).toBe(502);
    expect(answer.body).toContain("over 20 MB");
    expect(sent.bytes).toBeLessThan(40 * MB);
  });

  it("lets go of the first answer when it retries with a new Composio session", async () => {
    const answer = await ask("/mcp/forgotten");
    expect(answer).toMatchObject({ status: 200, body: '{"jsonrpc": "2.0", "id": 1}' });
    await vi.waitFor(() => expect(forgottenClosed).toBe(true));
  });
});

interface Forwarded {
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeComposio {
  origin: string;
  forwarded: Forwarded[];
  sessions: { opened: number };
  close(): void;
}

const ACCOUNTS = JSON.stringify({
  items: [{ id: "ca_1", status: "ACTIVE", alias: "work", toolkit: { slug: "gmail" } }],
  next_cursor: null,
});

async function echo(request: IncomingMessage, response: ServerResponse, forwarded: Forwarded[]) {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) body += String(chunk);
  forwarded.push({ headers: request.headers, body });
  response.writeHead(200, { "mcp-session-id": "mcp-next" }).end('{"jsonrpc": "2.0", "id": 1, "result": {}}');
}

/** Anything it doesn't know is a 404, the way Composio answers a session it forgot. */
async function startFakeComposio(): Promise<FakeComposio> {
  const forwarded: Forwarded[] = [];
  const sessions = { opened: 0 };
  const server = createServer((request, response) => {
    const path = (request.url ?? "").split("?")[0];
    if (path === "/mcp/echo") return void echo(request, response, forwarded);
    if (path === "/mcp/empty") return void response.writeHead(204).end();
    if (path === "/api/v3.1/connected_accounts")
      return void response.writeHead(200, { "content-type": "application/json" }).end(ACCOUNTS);
    if (path === "/api/v3.1/tool_router/session") sessions.opened++;
    response.writeHead(404, { "content-type": "application/json" }).end('{"error": "no such session"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected the fake Composio to listen");
  const close = () => {
    server.closeAllConnections();
    server.close();
  };
  return { origin: `http://127.0.0.1:${address.port}`, forwarded, sessions, close };
}

function useAppsRelay(bots: Bot[]) {
  const relay = new Relay(fakeHost(bots), []);
  let fake: FakeComposio | null = null;
  beforeAll(async () => {
    fake = await startFakeComposio();
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = fake.origin;
  });
  afterAll(() => {
    relay.stop();
    delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
    fake?.close();
  });
  const composio = () => defined(fake, "fake Composio");
  const mount = async (botId: string, route = "/mcp/echo") => {
    await writeState({
      apiKey: "ak_test",
      sessionId: "trs_1",
      mcpUrl: `${composio().origin}${route}`,
      multiAccount: true,
    });
    return httpMount(await relay.mountApps(botId));
  };
  return { composio, mount };
}

function send(target: { url: string; authorization: string }, message: unknown, headers = {}) {
  return fetch(target.url, {
    method: "POST",
    headers: { authorization: target.authorization, "content-type": "application/json", ...headers },
    body: JSON.stringify(message),
  });
}

function gmailBot(id: string, rule: Bot["appRules"][string]): Bot {
  return makeBot({ id, apps: ["gmail"], appRules: { gmail: rule } });
}

function execute(tool: Record<string, string>): unknown {
  return {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ arguments: {}, ...tool }] } },
  };
}

const WORKBENCH = {
  jsonrpc: "2.0",
  id: 4,
  method: "tools/call",
  params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: {} },
};

describe("the relay's connected apps endpoint", () => {
  useTempPaseoHome("paseo-bots-relay-apps-endpoint-");
  const { composio, mount } = useAppsRelay([
    makeBot({ id: "bot-1", apps: ["gmail"] }),
    makeBot({ id: "bot-off" }),
  ]);
  const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list" };

  it("passes the chat's MCP session and protocol version on with the key, and hands back the next session", async () => {
    const headers = { "mcp-session-id": "mcp-1", "mcp-protocol-version": "2025-06-18" };
    const answer = await send(await mount("bot-1"), LIST, headers);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("mcp-session-id")).toBe("mcp-next");
    expect(answer.headers.get("content-type")).toBe("application/json");
    expect(defined(composio().forwarded.at(-1)).headers).toMatchObject({
      "x-api-key": "ak_test",
      ...headers,
    });
  });

  it("hands a lost MCP session's 404 back to the chat instead of opening a new Composio session", async () => {
    const opened = composio().sessions.opened;
    const answer = await send(await mount("bot-1", "/mcp/gone"), LIST, { "mcp-session-id": "mcp-old" });
    expect(answer.status).toBe(404);
    expect(composio().sessions.opened).toBe(opened);
  });

  it("relays an answer without a body", async () => {
    const notification = { jsonrpc: "2.0", method: "notifications/initialized" };
    expect((await send(await mount("bot-1", "/mcp/empty"), notification)).status).toBe(204);
  });

  it("declines GET streams, ends sessions and answers a parse error to a body that isn't JSON", async () => {
    const { url, authorization } = await mount("bot-1");
    const stream = await fetch(url, { headers: { authorization } });
    expect(stream.status).toBe(405);
    expect(stream.headers.get("allow")).toBe("POST");
    expect((await fetch(url, { method: "DELETE", headers: { authorization } })).status).toBe(204);
    const garbled = await fetch(url, { method: "POST", headers: { authorization }, body: "{" });
    expect(garbled.status).toBe(400);
    expect(await garbled.json()).toMatchObject({ id: null, error: { code: -32700 } });
  });

  it("tells a bot without connected apps so, even for a message without an id", async () => {
    const answer = await send(await mount("bot-off"), {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(answer.status).toBe(403);
    expect(await answer.json()).toMatchObject({ id: null, error: { code: -32001 } });
  });
});

describe("the relay's app limits", () => {
  useTempPaseoHome("paseo-bots-relay-app-limits-");
  const { composio, mount } = useAppsRelay([
    gmailBot("bot-list", { tools: ["gmail_fetch_emails"], account: null }),
    gmailBot("bot-pinned", { tools: "all", account: "ca_9" }),
    gmailBot("bot-open", { tools: "all", account: null }),
  ]);
  const forwardedBody = () => JSON.parse(defined(composio().forwarded.at(-1)).body);

  it("keeps a bot to the tools it lists, whatever their case, and off the workbench", async () => {
    const target = await mount("bot-list");
    const refused = await send(target, execute({ tool_slug: "GMAIL_SEND_EMAIL" }));
    expect(await refused.text()).toContain("isn't allowed to run GMAIL_SEND_EMAIL");
    expect(await (await send(target, WORKBENCH)).text()).toContain("remote workbench");
    expect((await send(target, execute({ tool_slug: "GMAIL_FETCH_EMAILS" }))).status).toBe(200);
    expect(forwardedBody()).toMatchObject({
      params: { arguments: { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS" }] } },
    });
  });

  it("pins a bot to its account, by id when the account has no alias on this host", async () => {
    const target = await mount("bot-pinned");
    const refused = await send(target, execute({ tool_slug: "GMAIL_SEND_EMAIL", account: "work" }));
    expect(await refused.text()).toContain('may only use the account \\"ca_9\\"');
    expect((await send(target, execute({ tool_slug: "GMAIL_SEND_EMAIL" }))).status).toBe(200);
    expect(forwardedBody()).toMatchObject({ params: { arguments: { tools: [{ account: "ca_9" }] } } });
  });

  it("lets a bot with every tool and any account use the workbench", async () => {
    expect((await send(await mount("bot-open"), WORKBENCH)).status).toBe(200);
    expect(forwardedBody()).toMatchObject({ params: { name: "COMPOSIO_REMOTE_WORKBENCH" } });
  });
});
