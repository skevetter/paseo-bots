import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { removeKey, setKey } from "../server/composio";
import { APP_TOOLS } from "../server/control/tools/apps";
import { startControl } from "./control-helpers";
import { defined, makeBot, useTempPaseoHome } from "./helpers";

interface FakeAccount {
  id: string;
  status: string;
  toolkit: { slug: string };
  alias?: string | null;
  data?: Record<string, unknown>;
}

const fake = { origin: "", accounts: [] as FakeAccount[], links: [] as Record<string, unknown>[] };

const fakeAccounts = (): FakeAccount[] => [
  {
    id: "ca_1",
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    alias: "work",
    data: { displayName: "me@example.com", access_token: "secret-token" },
  },
  { id: "ca_3", status: "ACTIVE", toolkit: { slug: "gmail" }, alias: "personal" },
  { id: "ca_2", status: "ACTIVE", toolkit: { slug: "slack" } },
];

const TOOLKITS = [
  { slug: "gmail", name: "Gmail", meta: { description: "Email", app_url: "https://mail.google.com" } },
  { slug: "SLACK", name: "Slack", meta: { description: "Chat" } },
];

const GMAIL_TOOLS = [
  { slug: "GMAIL_SEND_EMAIL", name: "Send email", tags: ["openWorldHint"] },
  { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", tags: ["readOnlyHint"] },
];

type Send = (status: number, value: unknown) => void;

function routeAccounts(request: IncomingMessage, path: string, body: string, send: Send): boolean {
  if (path === "/api/v3.1/connected_accounts" && request.method === "GET") {
    send(200, { items: fake.accounts, next_cursor: null });
    return true;
  }
  const id = /^\/api\/v3(?:\.1)?\/connected_accounts\/(\w+)$/.exec(path)?.[1];
  if (request.method === "PATCH" && id) {
    const { alias } = z.object({ alias: z.string() }).parse(JSON.parse(body));
    fake.accounts = fake.accounts.map((entry) =>
      entry.id === id ? { ...entry, alias: alias || null } : entry,
    );
    send(200, {});
    return true;
  }
  if (request.method === "DELETE" && id) {
    fake.accounts = fake.accounts.filter((entry) => entry.id !== id);
    send(200, {});
    return true;
  }
  return false;
}

function route(request: IncomingMessage, response: ServerResponse, body: string) {
  const url = new URL(request.url ?? "/", fake.origin);
  const send: Send = (status, value) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (request.headers["x-api-key"] !== "ak_test") return send(401, { message: "Invalid API key" });
  if (url.pathname === "/api/v3.1/tool_router/session")
    return send(200, { session_id: "trs_1", mcp: { type: "http", url: `${fake.origin}/mcp/trs_1` } });
  if (url.pathname === "/api/v3.1/tool_router/session/trs_1/link") {
    fake.links.push(z.record(z.string(), z.unknown()).parse(JSON.parse(body)));
    return send(200, { redirect_url: `${fake.origin}/link/abc` });
  }
  if (url.pathname === "/api/v3/toolkits") return send(200, { items: TOOLKITS, next_cursor: null });
  if (url.pathname === "/api/v3/tools" && url.searchParams.get("toolkit_slug") === "gmail")
    return send(200, { items: GMAIL_TOOLS, next_cursor: null });
  if (!routeAccounts(request, url.pathname, body, send)) send(404, { message: "not found" });
}

const running: { stop(): Promise<void> }[] = [];

async function control(...args: Parameters<typeof startControl>) {
  const started = await startControl(...args);
  running.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((entry) => entry.stop()));
});

function serveFakeComposio() {
  let server: Server;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => route(request, response, body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address");
    fake.origin = `http://127.0.0.1:${address.port}`;
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = fake.origin;
  });

  beforeEach(async () => {
    fake.accounts = fakeAccounts();
    fake.links = [];
    await setKey({ key: "ak_test" });
  });

  afterAll(() => {
    server.close();
    delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
  });
}

function catalogTests() {
  it("reports whether apps are set up without the key", async () => {
    const { call } = await control(APP_TOOLS);
    const on = await call("apps_status");
    expect(on.data).toEqual({ configured: true });
    expect(on.text).not.toContain("ak_");
    await removeKey();
    const off = await call("apps_status");
    expect(off.data).toEqual({ configured: false });
    expect(off.text).toContain("Composio key");
    expect((await call("apps_catalog")).text).toContain("aren't set up");
  });

  it("searches the catalog", async () => {
    const { call } = await control(APP_TOOLS);
    const all = await call("apps_catalog");
    expect(all.data).toMatchObject({ total: 2, apps: [{ slug: "gmail" }, { slug: "slack" }] });
    const limited = await call("apps_catalog", { limit: 1 });
    expect(limited.data).toMatchObject({ total: 2, apps: [{ slug: "gmail" }] });
    const chat = await call("apps_catalog", { query: "chat" });
    expect(chat.data).toMatchObject({ total: 1, apps: [{ slug: "slack", name: "Slack" }] });
    expect((await call("apps_catalog", { query: "zzz" })).text).toContain('No apps match "zzz"');
  });

  it("lists accounts without their tokens", async () => {
    const { call } = await control(APP_TOOLS);
    const listed = await call("apps_accounts", { fresh: true });
    expect(listed.data.accounts).toEqual([
      expect.objectContaining({ id: "ca_1", slug: "gmail", alias: "work", name: "me@example.com" }),
      expect.objectContaining({ id: "ca_3", alias: "personal" }),
      expect.objectContaining({ id: "ca_2", slug: "slack", status: "connected" }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("secret-token");
    expect(listed.text).toContain("gmail: work (ca_1, connected)");
  });
}

function accountTests() {
  it("returns a sign-in link for the user to open", async () => {
    const { call } = await control(APP_TOOLS);
    const linked = await call("apps_connect", { slug: "Notion", alias: "team" });
    expect(linked.data).toEqual({ app: "notion", url: `${fake.origin}/link/abc` });
    expect(linked.text).toContain(`${fake.origin}/link/abc`);
    expect(fake.links).toEqual([{ toolkit: "notion", alias: "team" }]);
  });

  it("renames and clears an account's name", async () => {
    const { call } = await control(APP_TOOLS);
    expect((await call("apps_rename", { account: "ca_2", alias: " team " })).data).toMatchObject({
      alias: "team",
    });
    expect(fake.accounts.find((entry) => entry.id === "ca_2")?.alias).toBe("team");
    await call("apps_rename", { account: "ca_2", alias: "" });
    expect((await call("apps_accounts")).data.accounts).toContainEqual(
      expect.objectContaining({ id: "ca_2", alias: null }),
    );
    expect((await call("apps_rename", { account: "ca_other", alias: "x" })).isError).toBe(true);
  });

  it("lists and filters an app's tools", async () => {
    const { call } = await control(APP_TOOLS);
    const listed = await call("apps_tools", { app: "gmail" });
    expect(listed.data.tools).toEqual([
      { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", readOnly: true },
      { slug: "GMAIL_SEND_EMAIL", name: "Send email", readOnly: false },
    ]);
    const found = await call("apps_tools", { app: "gmail", query: "send" });
    expect(found.data.tools).toEqual([expect.objectContaining({ slug: "GMAIL_SEND_EMAIL" })]);
  });

  it("disconnects an account only when confirmed", async () => {
    const { call } = await control(APP_TOOLS);
    const refused = await call("apps_disconnect", { account: "ca_2" });
    expect(refused.isError).toBe(true);
    expect(fake.accounts.map((entry) => entry.id)).toContain("ca_2");
    expect((await call("apps_disconnect", { account: "ca_2", confirm: true })).isError).toBe(false);
    expect(fake.accounts.map((entry) => entry.id)).not.toContain("ca_2");
  });
}

function botAppTests() {
  it("switches an app on with limits, keeps them on later changes, and drops them when off", async () => {
    const { call, store } = await control(APP_TOOLS, { bots: [makeBot({ id: "bot-a", name: "Inbox" })] });
    const bot = async () => defined((await store.read()).values.bots.find((entry) => entry.id === "bot-a"));

    const on = await call("bots_apps_set", {
      bot: "Inbox",
      app: "Gmail",
      on: true,
      tools: "read",
      account: "personal",
    });
    expect(on.isError).toBe(false);
    expect(await bot()).toMatchObject({
      apps: ["gmail"],
      appRules: { gmail: { tools: "read", account: "ca_3" } },
    });

    await call("bots_apps_set", { bot: "Inbox", app: "gmail", on: true, tools: ["GMAIL_SEND_EMAIL"] });
    expect((await bot()).appRules.gmail).toEqual({ tools: ["GMAIL_SEND_EMAIL"], account: "ca_3" });

    await call("bots_apps_set", { bot: "Inbox", app: "slack", on: true });
    await call("bots_apps_set", { bot: "Inbox", app: "gmail", on: true, tools: "all", account: null });
    expect(await bot()).toMatchObject({ apps: ["gmail", "slack"], appRules: {} });

    const missing = await call("bots_apps_set", { bot: "Inbox", app: "gmail", on: true, account: "school" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('no account called "school"');

    const off = await call("bots_apps_set", { bot: "Inbox", app: "slack", on: false });
    expect(off.data).toMatchObject({ apps: ["gmail"] });
    expect((await bot()).apps).toEqual(["gmail"]);
    expect((await call("bots_apps_set", { bot: "Inbox", app: "slack", on: false })).text).toContain(
      "doesn't use slack",
    );
    expect(
      (await call("bots_apps_set", { bot: "Inbox", app: "gmail", on: false, tools: "read" })).isError,
    ).toBe(true);
  });

  it("drops a pinned account once it's disconnected, as the access sheet does", async () => {
    const { call, store } = await control(APP_TOOLS, {
      bots: [
        makeBot({ id: "bot-a", apps: ["gmail"], appRules: { gmail: { tools: "all", account: "ca_3" } } }),
      ],
    });
    await call("apps_disconnect", { account: "ca_3", confirm: true });
    await call("bots_apps_set", { bot: "bot-a", app: "gmail", on: true, tools: "read" });
    const saved = defined((await store.read()).values.bots[0]);
    expect(saved.appRules.gmail).toEqual({ tools: "read", account: null });
  });
}

describe("app control tools", () => {
  useTempPaseoHome("paseo-bots-control-apps-");
  serveFakeComposio();
  catalogTests();
  accountTests();
  botAppTests();
});
