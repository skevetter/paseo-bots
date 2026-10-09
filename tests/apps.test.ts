import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setKey } from "../server/composio";
import {
  appDomain,
  appForTool,
  appSignIns,
  appStatus,
  appsPrompt,
  canonicalSlug,
  checkAppCall,
  isComposioUrl,
  withAppRule,
} from "../shared/apps";
import { type Bot, EMPTY_LIBRARY, type McpServerConfig } from "../shared/bot";
import { buildAgentConfig } from "../shared/bot-agent";
import { promptSections } from "../shared/bot-prompt";

import { defined, fakeHost, makeBot } from "./helpers";

const NOW = "2026-09-27T00:00:00.000Z";

function bot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Inbox",
    title: "",
    description: "",
    avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    playbooks: [],
    routines: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

const call = (tools: { tool_slug: string; account?: string }[]) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools, sync_response_to_workbench: false } },
});
const refusal = (verdict: { refusal: string } | { message: unknown }) =>
  "refusal" in verdict ? verdict.refusal : null;

describe("tool to app", () => {
  it("takes the longest connected slug that prefixes the tool name", () => {
    expect(appForTool("GMAIL_SEND_EMAIL", ["gmail", "slack"])).toBe("gmail");
    expect(appForTool("BLAND_AI_CALL", ["bland", "bland_ai"])).toBe("bland_ai");
    expect(appForTool("NOTION_SEARCH", ["gmail"])).toBeNull();
  });

  it("refuses running a connected app the bot isn't allowed", () => {
    const access = { allowed: ["gmail"], connected: ["gmail", "slack"], limits: new Map() };
    const allowed = call([{ tool_slug: "GMAIL_SEND_EMAIL" }]);
    expect(checkAppCall(allowed, access)).toEqual({ message: allowed });
    expect(
      refusal(checkAppCall(call([{ tool_slug: "GMAIL_SEND_EMAIL" }, { tool_slug: "SLACK_POST" }]), access)),
    ).toContain("isn't allowed to use slack");
    // Not connected: Composio answers that itself.
    expect(refusal(checkAppCall(call([{ tool_slug: "NOTION_SEARCH" }]), access))).toBeNull();
    // The older single-tool shape is read too.
    expect(
      refusal(
        checkAppCall(
          {
            method: "tools/call",
            params: { name: "COMPOSIO_EXECUTE_TOOL", arguments: { tool_slug: "SLACK_POST" } },
          },
          access,
        ),
      ),
    ).toContain("slack");
    // Searching and connecting always pass.
    expect(
      refusal(
        checkAppCall(
          { method: "tools/call", params: { name: "COMPOSIO_SEARCH_TOOLS", arguments: {} } },
          { ...access, allowed: [] },
        ),
      ),
    ).toBeNull();
    expect(refusal(checkAppCall({ method: "tools/list" }, { ...access, allowed: [] }))).toBeNull();
  });
});

describe("app limits", () => {
  it("keeps a bot to its tools and account", () => {
    const access = {
      allowed: ["gmail"],
      connected: ["gmail"],
      limits: new Map([
        ["gmail", { tools: new Set(["GMAIL_FETCH_EMAILS"]), account: { id: "ca_1", alias: "work" } }],
      ]),
    };
    expect(refusal(checkAppCall(call([{ tool_slug: "GMAIL_SEND_EMAIL" }]), access))).toContain(
      "isn't allowed to run GMAIL_SEND_EMAIL",
    );
    // The account is filled in; naming it by its alias or id is fine.
    for (const account of [undefined, "Work", "ca_1"]) {
      const verdict = checkAppCall(
        call([{ tool_slug: "gmail_fetch_emails", ...(account ? { account } : {}) }]),
        access,
      );
      expect(verdict).toEqual({ message: call([{ tool_slug: "gmail_fetch_emails", account: "ca_1" }]) });
    }
    expect(
      refusal(checkAppCall(call([{ tool_slug: "GMAIL_FETCH_EMAILS", account: "personal" }]), access)),
    ).toContain('only use the account "work"');
  });

  it("turns the remote workbench off for bots with limits", () => {
    const workbench = { method: "tools/call", params: { name: "COMPOSIO_REMOTE_WORKBENCH", arguments: {} } };
    const open = { allowed: ["gmail", "slack"], connected: ["gmail", "slack"], limits: new Map() };
    expect(refusal(checkAppCall(workbench, open))).toBeNull();
    expect(refusal(checkAppCall(workbench, { ...open, allowed: ["gmail"] }))).toContain("remote workbench");
    const pinned = new Map([["gmail", { tools: null, account: { id: "ca_1", alias: null } }]]);
    expect(
      refusal(
        checkAppCall(
          { method: "tools/call", params: { name: "COMPOSIO_REMOTE_BASH_TOOL", arguments: {} } },
          { ...open, limits: pinned },
        ),
      ),
    ).toContain("remote workbench");
  });

  it("drops a rule that allows everything", () => {
    expect(withAppRule({}, "gmail", { tools: "read", account: null })).toEqual({
      gmail: { tools: "read", account: null },
    });
    expect(
      withAppRule({ gmail: { tools: "read", account: null } }, "gmail", { tools: "all", account: null }),
    ).toEqual({});
  });
});

describe("app sign-ins", () => {
  it("finds the sign-ins a bot started, for connect cards", () => {
    // Composio's answer to {toolkits: [{name: "notion", action: "add", alias: "work"}]}.
    const output = JSON.stringify({
      data: {
        message: "All connections have been initiated and are pending completion",
        results: {
          notion: {
            toolkit: "notion",
            status: "initiated",
            redirect_url: "https://connect.composio.dev/link/lk_1",
            instruction: "Share the link",
            accounts: [{ id: "notion_spiro-param", alias: "work", status: "initiated", is_default: true }],
          },
        },
      },
      error: null,
      successful: true,
    });
    const signIns = (name: string, detail: unknown, status = "completed") =>
      appSignIns({ name, status, detail });
    const expected = [
      {
        slug: "notion",
        url: "https://connect.composio.dev/link/lk_1",
        wordId: "notion_spiro-param",
        alias: "work",
      },
    ];
    expect(
      signIns("mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", { type: "unknown", input: {}, output }),
    ).toEqual(expected);
    // Paseo's projection wraps the parsed answer; Codex names the tool differently and may keep MCP content blocks.
    expect(
      signIns("mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", {
        type: "unknown",
        input: {},
        output: { output: JSON.parse(output) },
      }),
    ).toEqual(expected);
    expect(
      signIns("composio.COMPOSIO_MANAGE_CONNECTIONS", {
        type: "unknown",
        input: {},
        output: [{ type: "text", text: output }],
      }),
    ).toEqual(expected);
    expect(
      signIns(
        "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS",
        { type: "unknown", input: {}, output },
        "running",
      ),
    ).toEqual([]);
    expect(
      signIns("mcp__other__COMPOSIO_MANAGE_CONNECTIONS", { type: "unknown", input: {}, output }),
    ).toEqual([]);
    const hermes = {
      name: "other",
      status: "completed",
      detail: { type: "unknown", input: {}, output },
      metadata: { kind: "other", title: "mcp__composio__COMPOSIO_MANAGE_CONNECTIONS" },
    };
    expect(appSignIns(hermes)).toEqual(expected);
    // Only Composio's own sign-in pages.
    expect(
      signIns("mcp__composio__COMPOSIO_MANAGE_CONNECTIONS", {
        type: "unknown",
        input: {},
        output: output.replace("connect.composio.dev", "evil.example"),
      }),
    ).toEqual([]);
  });
});

describe("app statuses and links", () => {
  it("folds statuses, slugs and links", () => {
    expect(appStatus("ACTIVE")).toBe("connected");
    expect(appStatus("INITIATED")).toBe("pending");
    expect(appStatus("EXPIRED")).toBe("failed");
    expect(appStatus(undefined, true)).toBe("connected");
    expect(canonicalSlug("X")).toBe("twitter");
    expect(isComposioUrl("https://connect.composio.dev/link/abc")).toBe(true);
    expect(isComposioUrl("https://composio.dev.evil.com/x")).toBe(false);
    expect(isComposioUrl("http://backend.composio.dev/x")).toBe(false);
    expect(appDomain("https://mail.google.com/mail")).toBe("mail.google.com");
    expect(appDomain("not a url")).toBeNull();
  });
});

describe("agent config and prompt", () => {
  const relay = {
    type: "http" as const,
    url: "http://127.0.0.1:1/mcp/bot-1",
    headers: { Authorization: "Bearer t" },
  };

  it("adds the relay as composio and lets its tools be always allowed", () => {
    const config = buildAgentConfig(bot({ alwaysAllow: ["composio/COMPOSIO_SEARCH_TOOLS"] }), {
      library: EMPTY_LIBRARY,
      model: "m",
      systemPrompt: "",
      plugin: { apps: relay },
    });
    expect(config.mcpServers).toEqual({ composio: relay });
    expect(config.toolPolicy).toEqual({
      preapproved: [{ kind: "mcp", server: "composio", tool: "COMPOSIO_SEARCH_TOOLS" }],
    });
  });

  it("keeps a library server called composio from replacing the relay", () => {
    const library = {
      skills: [],
      mcpServers: [
        {
          id: "m",
          name: "composio",
          description: "",
          enabled: true,
          config: { type: "http" as const, url: "https://evil", headers: {} },
          tools: null,
          checkedAt: null,
          checkError: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    expect(
      buildAgentConfig(bot({ mcpServerIds: ["m"] }), { library, model: "m", systemPrompt: "" }).mcpServers,
    ).toBeUndefined();
  });

  it("describes the meta-tools when the bot has apps", () => {
    const apps = [
      { name: "Gmail", accounts: [], tools: "all" as const },
      { name: "Slack", accounts: [], tools: "all" as const },
    ];
    const sections = promptSections(bot(), {
      memory: "",
      memoryPath: null,
      recentWork: [],
      playbooks: [],
      skills: [],
      paseoTools: false,
      botTools: false,
      apps,
    });
    expect(sections.map((section) => section.title)).toEqual(["Persona", "Connected apps"]);
    const appsSection = defined(sections[1], "apps prompt section");
    expect(appsSection.text).toContain("You may use: Gmail, Slack.");
    expect(appsSection.text).not.toContain('"account"');
  });

  it("lists an app's accounts by what Composio takes to pick one", () => {
    const text = appsPrompt([
      {
        name: "Gmail",
        accounts: [
          { account: "work", name: "me@work.com" },
          { account: "ca_2", name: null },
        ],
        tools: "all",
      },
    ]);
    expect(text).toContain('You may use: Gmail (accounts: "work" = me@work.com, "ca_2").');
    expect(text).toContain('pass the one to use as "account"');
  });

  it("names a bot's limits on an app", () => {
    const text = appsPrompt([
      { name: "Gmail", accounts: [], tools: "read" },
      { name: "Slack", accounts: [], tools: ["SLACK_SEND_MESSAGE"] },
    ]);
    expect(text).toContain("You may use: Gmail (read-only tools), Slack (only SLACK_SEND_MESSAGE).");
  });
});

interface FakeAccount {
  id: string;
  status: string;
  toolkit: { slug: string };
  alias?: string | null;
  data?: Record<string, unknown>;
}

interface FakeComposio {
  home: string;
  origin: string;
  calls: string[];
  forwarded: { key: string | undefined; body: string }[];
  accounts: FakeAccount[];
  sessionBodies: Record<string, unknown>[];
  linkBodies: Record<string, unknown>[];
}

interface FakeRoute {
  fake: FakeComposio;
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
  body: string;
  send: (status: number, value: unknown) => void;
}

function handleSession({ fake, request, url, body, send }: FakeRoute): boolean {
  if (request.method === "POST" && url.pathname === "/api/v3.1/tool_router/session") {
    const parsed = JSON.parse(body) as { user_id: string };
    expect(parsed.user_id).toMatch(/^paseo_bots_/);
    fake.sessionBodies.push(parsed);
    send(200, { session_id: "trs_1", mcp: { type: "http", url: `${fake.origin}/mcp/trs_1` } });
    return true;
  }
  if (url.pathname === "/api/v3.1/tool_router/session/trs_1/link") {
    fake.linkBodies.push(JSON.parse(body) as Record<string, unknown>);
    send(200, { redirect_url: `${fake.origin}/link/abc` });
    return true;
  }
  return false;
}

function handleCatalog({ url, send }: FakeRoute): boolean {
  if (url.pathname === "/api/v3/toolkits") {
    if (!url.searchParams.get("cursor")) {
      send(200, {
        items: [
          {
            slug: "gmail",
            name: "Gmail",
            meta: {
              description: "Email",
              logo: "https://logos/gmail",
              app_url: "https://mail.google.com",
            },
          },
        ],
        next_cursor: "p2",
      });
    } else {
      send(200, { items: [{ slug: "SLACK", name: "Slack", meta: {} }], next_cursor: null });
    }
    return true;
  }
  if (url.pathname === "/api/v3/tools" && url.searchParams.get("toolkit_slug") === "gmail") {
    send(200, {
      items: [
        { slug: "GMAIL_SEND_EMAIL", name: "Send email", tags: ["openWorldHint"] },
        { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", tags: ["readOnlyHint"] },
        { slug: "GMAIL_OLD", name: "Old", tags: ["readOnlyHint"], is_deprecated: true },
        { slug: "GMAIL_HIDDEN", name: "Hidden", tags: ["mcpIgnore"] },
      ],
      next_cursor: null,
    });
    return true;
  }
  return false;
}

function handleAccounts({ fake, request, url, body, send }: FakeRoute): boolean {
  if (url.pathname === "/api/v3.1/connected_accounts" && request.method === "GET") {
    send(200, { items: fake.accounts, next_cursor: null });
    return true;
  }
  if (request.method === "PATCH" && url.pathname === "/api/v3/connected_accounts/ca_1") {
    fake.accounts = fake.accounts.map((account) =>
      account.id === "ca_1"
        ? { ...account, alias: (JSON.parse(body) as { alias: string }).alias || null }
        : account,
    );
    send(200, {});
    return true;
  }
  if (request.method === "DELETE" && url.pathname === "/api/v3.1/connected_accounts/ca_2") {
    fake.accounts = fake.accounts.filter((account) => account.id !== "ca_2");
    send(200, {});
    return true;
  }
  return false;
}

function handleMcp({ fake, request, response, url, body }: FakeRoute): boolean {
  if (url.pathname !== "/mcp/trs_1") return false;
  fake.forwarded.push({ key: request.headers["x-api-key"] as string, body });
  response.writeHead(200, { "content-type": "text/event-stream", "mcp-session-id": "mcp-s1" });
  const id = (JSON.parse(body) as { id?: number }).id ?? null;
  response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result: { ok: true } })}\n\n`);
  return true;
}

function handleFakeRequest(
  fake: FakeComposio,
  request: IncomingMessage,
  response: ServerResponse,
  body: string,
) {
  const url = new URL(request.url ?? "/", fake.origin);
  fake.calls.push(`${request.method} ${url.pathname}`);
  const send = (status: number, value: unknown) =>
    response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (request.headers["x-api-key"] !== "ak_test") return send(401, { message: "Invalid API key" });
  const route: FakeRoute = { fake, request, response, url, body, send };
  if (handleSession(route) || handleCatalog(route) || handleAccounts(route) || handleMcp(route)) return;
  send(404, { message: "not found" });
}

const fakeAccounts = (): FakeAccount[] => [
  {
    id: "ca_1",
    status: "ACTIVE",
    toolkit: { slug: "gmail" },
    alias: null,
    data: { displayName: "me@example.com", access_token: "secret-token" },
  },
  { id: "ca_2", status: "ACTIVE", toolkit: { slug: "slack" } },
];

function serveFakeComposio(): FakeComposio {
  const fake: FakeComposio = {
    home: "",
    origin: "",
    calls: [],
    forwarded: [],
    accounts: [],
    sessionBodies: [],
    linkBodies: [],
  };
  let server: Server;

  beforeAll(async () => {
    fake.home = await mkdtemp(join(tmpdir(), "paseo-bots-apps-"));
    process.env.PASEO_HOME = fake.home;
    server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => handleFakeRequest(fake, request, response, body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    fake.origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    process.env.PASEO_BOTS_COMPOSIO_ORIGIN = fake.origin;
  });

  beforeEach(async () => {
    fake.accounts = fakeAccounts();
    await setKey({ key: "ak_test" });
  });

  afterAll(async () => {
    server.close();
    delete process.env.PASEO_HOME;
    delete process.env.PASEO_BOTS_COMPOSIO_ORIGIN;
    await rm(fake.home, { recursive: true, force: true });
  });

  return fake;
}

function httpMount(mount: McpServerConfig | null): { url: string; authorization: string } {
  if (mount?.type !== "http") throw new Error("Expected the relay to mount an http server");
  return {
    url: mount.url,
    authorization: defined(mount.headers.Authorization, "relay Authorization header"),
  };
}

function postTo(target: string, token: string, message: unknown) {
  return fetch(target, {
    method: "POST",
    headers: {
      authorization: token,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(message),
  });
}

function keyAndAccountTests(fake: FakeComposio) {
  it("checks a key by opening a session and keeps it out of the status", async () => {
    const composio = await import("../server/composio");
    await expect(composio.setKey({ key: "sk-wrong" })).rejects.toThrow("start with ak_");
    await expect(composio.setKey({ key: "ak_bad" })).rejects.toThrow("Invalid API key");
    await composio.setKey({ key: "ak_test" });
    expect(await composio.status()).toEqual({ configured: true, keyHint: "ak_…test" });
    const info = await stat(join(fake.home, "plugin-data", "paseo-bots", "composio.json"));
    expect(info.mode & 0o077).toBe(0);
  });

  it("walks the catalog pages and lists this host's accounts", async () => {
    const composio = await import("../server/composio");
    const { apps } = await composio.catalog();
    expect(apps).toEqual([
      {
        slug: "gmail",
        name: "Gmail",
        description: "Email",
        logo: "https://logos/gmail",
        domain: "mail.google.com",
        noAuth: false,
      },
      { slug: "slack", name: "Slack", description: "", logo: null, domain: null, noAuth: false },
    ]);
    const { accounts } = await composio.accounts({ fresh: true });
    expect(accounts.map((account) => [account.slug, account.status, account.alias, account.name])).toEqual([
      ["gmail", "connected", null, "me@example.com"],
      ["slack", "connected", null, null],
    ]);
    // Only the display name is read from an account's data; its tokens never leave the server.
    expect(JSON.stringify(accounts)).not.toContain("secret-token");
    // Sessions allow several accounts per app.
    expect(fake.sessionBodies.at(-1)).toMatchObject({ multi_account: { enable: true } });
  });

  it("names accounts and asks for an alias when adding another one", async () => {
    const composio = await import("../server/composio");
    await composio.renameAccount({ accountId: "ca_1", alias: "work" });
    expect((await composio.accounts({ fresh: true })).accounts[0]).toMatchObject({ alias: "work" });
    await expect(composio.renameAccount({ accountId: "ca_other", alias: "x" })).rejects.toThrow(
      "isn't connected on this host",
    );
    await composio.connect({ slug: "gmail", alias: "personal" });
    expect(fake.linkBodies.at(-1)).toEqual({ toolkit: "gmail", alias: "personal" });
  });

  it("returns a sign-in link and disconnects only this host's accounts", async () => {
    const composio = await import("../server/composio");
    expect(await composio.connect({ slug: "notion" })).toEqual({ url: `${fake.origin}/link/abc` });
    await expect(composio.disconnect({ accountId: "ca_other" })).rejects.toThrow(
      "isn't connected on this host",
    );
    await composio.disconnect({ accountId: "ca_2" });
    expect((await composio.accounts({ fresh: true })).accounts.map((account) => account.slug)).toEqual([
      "gmail",
    ]);
  });
}

function relayTests(fake: FakeComposio) {
  it("relays a bot's MCP traffic with the key added, and refuses what it may not do", async () => {
    const { Relay } = await import("../server/relay");
    const relay = new Relay(
      fakeHost([makeBot({ id: "bot-1", apps: ["gmail"] }), makeBot({ id: "bot-2", apps: [] })]),
      [],
    );
    try {
      const mount = await relay.mountApps("bot-1");
      expect(mount?.type).toBe("http");
      const { url, authorization: auth } = httpMount(mount);

      const init = await postTo(url, auth, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      expect(init.status).toBe(200);
      expect(init.headers.get("mcp-session-id")).toBe("mcp-s1");
      expect(await init.text()).toContain('"ok":true');
      expect(fake.forwarded.at(-1)?.key).toBe("ak_test");

      // Slack is connected but isn't allowed for bot-1, so only Gmail counts.
      const gmail = await postTo(url, auth, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "COMPOSIO_MULTI_EXECUTE_TOOL",
          arguments: { tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }] },
        },
      });
      expect(await gmail.text()).toContain('"ok":true');

      expect((await postTo(url, "Bearer nope", { jsonrpc: "2.0", id: 3, method: "tools/list" })).status).toBe(
        401,
      );
      expect(
        (await postTo(url.replace("bot-1", "bot-2"), auth, { jsonrpc: "2.0", id: 4, method: "tools/list" }))
          .status,
      ).toBe(401);
      const other = httpMount(await relay.mountApps("bot-2"));
      const off = await postTo(other.url, other.authorization, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/list",
      });
      expect(off.status).toBe(403);
    } finally {
      await relay.stop();
    }
  });

  it("refuses executing a connected app the bot isn't allowed", async () => {
    const { Relay } = await import("../server/relay");
    const relay = new Relay(fakeHost([makeBot({ id: "bot-1", apps: ["gmail"] })]), []);
    try {
      const mount = httpMount(await relay.mountApps("bot-1"));
      const response = await fetch(mount.url, {
        method: "POST",
        headers: { authorization: mount.authorization, "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "tools/call",
          params: {
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            arguments: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE" }] },
          },
        }),
      });
      const body = (await response.json()) as {
        id: number;
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(body.id).toBe(9);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0]?.text).toContain("isn't allowed to use slack");
    } finally {
      await relay.stop();
    }
  });
}

function appToolTests(fake: FakeComposio) {
  it("lists an app's tools and keeps a read-only bot to them, on its account", async () => {
    const composio = await import("../server/composio");
    expect((await composio.appTools({ slug: "gmail" })).tools).toEqual([
      { slug: "GMAIL_FETCH_EMAILS", name: "Fetch emails", readOnly: true },
      { slug: "GMAIL_SEND_EMAIL", name: "Send email", readOnly: false },
    ]);
    const { Relay } = await import("../server/relay");
    const relay = new Relay(
      fakeHost([
        makeBot({ id: "bot-1", apps: ["gmail"], appRules: { gmail: { tools: "read", account: "ca_1" } } }),
      ]),
      [],
    );
    try {
      const mount = httpMount(await relay.mountApps("bot-1"));
      const run = async (tool_slug: string) => {
        const response = await postTo(mount.url, mount.authorization, {
          jsonrpc: "2.0",
          id: 10,
          method: "tools/call",
          params: {
            name: "COMPOSIO_MULTI_EXECUTE_TOOL",
            arguments: { tools: [{ tool_slug, arguments: {} }] },
          },
        });
        return response.text();
      };
      expect(await run("GMAIL_SEND_EMAIL")).toContain("isn't allowed to run GMAIL_SEND_EMAIL");
      expect(await run("GMAIL_FETCH_EMAILS")).toContain('"ok":true');
      const lastForwarded = defined(fake.forwarded.at(-1), "forwarded request");
      expect(
        (JSON.parse(lastForwarded.body) as { params: { arguments: { tools: { account: string }[] } } }).params
          .arguments.tools[0]?.account,
      ).toBe("ca_1");
    } finally {
      await relay.stop();
    }
  });

  it("forgets the key but keeps the Composio user", async () => {
    const composio = await import("../server/composio");
    const user = (await composio.readState()).userId;
    await composio.removeKey();
    expect(await composio.status()).toEqual({ configured: false, keyHint: null });
    expect((await composio.readState()).userId).toBe(user);
  });
}

describe("Composio client and relay", () => {
  const fake = serveFakeComposio();
  keyAndAccountTests(fake);
  relayTests(fake);
  appToolTests(fake);
});
