import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { writeState } from "../server/composio";
import { Relay } from "../server/relay";
import type { McpServerConfig } from "../shared/bot";
import { newUuid } from "../shared/uuid";
import { fakeHost, makeBot, useTempPaseoHome } from "./helpers";

function mount(config: McpServerConfig | null | undefined) {
  if (config?.type !== "http") throw new Error("Expected an HTTP relay");
  return config;
}

async function call(target: ReturnType<typeof mount>, tool: Record<string, string>) {
  const response = await fetch(target.url, {
    method: "POST",
    headers: { ...target.headers, "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ arguments: {}, ...tool }] } },
    }),
  });
  return response.json();
}

async function connector() {
  const effects: unknown[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/api/v3.1/connected_accounts")) {
      response.end(
        JSON.stringify({
          items: [{ id: "ca_1", status: "ACTIVE", alias: "work", toolkit: { slug: "gmail" } }],
          next_cursor: null,
        }),
      );
      return;
    }
    if (request.url !== "/mcp/echo") return void response.writeHead(404).end();
    let body = "";
    for await (const chunk of request) body += String(chunk);
    effects.push(JSON.parse(body));
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "allowed" }] } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Connector did not listen");
  return { server, effects, origin: `http://127.0.0.1:${address.port}` };
}

describe("legacy cold connected-app authorization", () => {
  useTempPaseoHome("legacy-relay-apps-");

  it("retains the admitted read tool and account despite broader current grants", async () => {
    const upstream = await connector();
    const previous = process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = upstream.origin;
    const bot = makeBot({
      apps: ["gmail"],
      appRules: { gmail: { tools: ["gmail_fetch_emails"], account: "ca_1" } },
    });
    const host = fakeHost([bot]);
    const writer = new Relay(host, []);
    const recovered = new Relay(host, []);
    try {
      await writeState({
        apiKey: "ak_cold_legacy",
        sessionId: "trs_cold",
        mcpUrl: `${upstream.origin}/mcp/echo`,
        multiAccount: true,
      });
      const frozen = { tools: false, apps: true, permissions: await writer.preparePermissions(bot) };
      const target = mount(
        (await writer.mountPrepared(bot.id, newUuid(), frozen, { durableLegacy: true })).apps,
      );
      await writer.close();
      bot.appRules = { gmail: { tools: "all", account: null } };
      await recovered.start();
      expect(await call(target, { tool_slug: "GMAIL_SEND_EMAIL" })).toMatchObject({
        result: { isError: true },
      });
      expect(await call(target, { tool_slug: "GMAIL_FETCH_EMAILS", account: "other" })).toMatchObject({
        result: { isError: true },
      });
      expect(upstream.effects).toEqual([]);
      expect(await call(target, { tool_slug: "GMAIL_FETCH_EMAILS" })).toMatchObject({
        result: { content: [{ text: "allowed" }] },
      });
      expect(upstream.effects).toEqual([
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            arguments: { tools: [{ arguments: {}, tool_slug: "GMAIL_FETCH_EMAILS", account: "ca_1" }] },
          },
        },
      ]);
    } finally {
      await Promise.all([writer.close(), recovered.close()]);
      if (previous === undefined) delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
      else process.env.PASEO_BOTS_COMPOSIO_ORIGIN = previous;
      upstream.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
