import {
  type ClientRequest,
  createServer,
  request as httpRequest,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { Server } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writeState } from "../server/composio";
import { BodyTooLargeError, Relay, readBody } from "../server/relay";
import type { McpServerConfig } from "../shared/bot";
import { newUuid } from "../shared/uuid";
import { defined, fakeHost, makeBot, useTempPaseoHome } from "./helpers";

const MB = 1024 * 1024;

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
