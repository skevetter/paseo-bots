import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type AppAccount,
  type AppCard,
  type AppTool,
  appDomain,
  appStatus,
  canonicalSlug,
  isComposioUrl,
} from "../shared/apps";
import { pluginDataPath } from "./bot-home";

// The project key stays in a file only this process reads; clients never see it.

/** Tests point this at a local fake; its URLs are then trusted like composio.dev's. */
const ORIGIN_OVERRIDE = () => process.env.PASEO_BOTS_COMPOSIO_ORIGIN?.replace(/\/$/, "");
const ORIGIN = () => ORIGIN_OVERRIDE() ?? "https://backend.composio.dev";
const API = () => `${ORIGIN()}/api/v3.1`;
const CATALOG_API = () => `${ORIGIN()}/api/v3`;
const CATALOG_TTL_MS = 10 * 60_000;
const CONNECTED_TTL_MS = 30_000;
const MAX_PAGES = 20;
const MAX_ACCOUNTS_PER_APP = 5;

interface State {
  apiKey: string | null;
  /** Composio user the connections belong to; kept when the key is removed so they survive re-adding it. */
  userId: string;
  sessionId: string | null;
  mcpUrl: string | null;
  /** Signs each bot's relay token. */
  secret: string;
  /** Last relay port, reused so running chats keep their MCP URL across restarts. */
  port: number | null;
  /** Whether the session allows several accounts per app; older sessions are replaced. */
  multiAccount?: boolean;
}

function statePath(): string {
  return join(pluginDataPath(), "composio.json");
}

let cached: State | null = null;

export async function readState(): Promise<State> {
  if (cached) return cached;
  try {
    cached = JSON.parse(await readFile(statePath(), "utf8")) as State;
  } catch {
    cached = {
      apiKey: null,
      userId: `paseo_bots_${randomUUID()}`,
      sessionId: null,
      mcpUrl: null,
      secret: randomBytes(32).toString("hex"),
      port: null,
    };
  }
  return cached;
}

export async function writeState(patch: Partial<State>): Promise<State> {
  const next = { ...(await readState()), ...patch };
  cached = next;
  await mkdir(dirname(statePath()), { recursive: true });
  await writeFile(statePath(), JSON.stringify(next, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(statePath(), 0o600).catch(() => {});
  return next;
}

/** AbortSignal.timeout isn't in this project's Node types. */
export function deadline(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms).unref?.();
  return controller.signal;
}

function trusted(url: string): boolean {
  const override = ORIGIN_OVERRIDE();
  return isComposioUrl(url) || (!!override && url.startsWith(`${override}/`));
}

function headers(apiKey: string, json = false): Record<string, string> {
  return { "x-api-key": apiKey, ...(json ? { "content-type": "application/json" } : {}) };
}

async function failure(response: Response, fallback: string): Promise<Error> {
  const raw = await response.text().catch(() => "");
  let message = raw.trim().slice(0, 300);
  try {
    const body = JSON.parse(raw) as { message?: unknown; error?: { message?: unknown } | string };
    message = String(
      body.message ?? (typeof body.error === "object" ? body.error?.message : body.error) ?? message,
    );
  } catch {
    // Not JSON; keep the text.
  }
  return new Error(message || fallback);
}

interface SessionResponse {
  session_id: string;
  mcp: { type: string; url: string };
}

async function createSession(apiKey: string, userId: string): Promise<SessionResponse> {
  const response = await fetch(`${API()}/tool_router/session`, {
    method: "POST",
    headers: headers(apiKey, true),
    body: JSON.stringify({
      user_id: userId,
      manage_connections: {
        enable: true,
        enable_wait_for_connections: true,
        enable_connection_removal: false,
      },
      // Bots pick among several accounts per app by alias.
      multi_account: { enable: true, max_accounts_per_toolkit: MAX_ACCOUNTS_PER_APP },
    }),
    signal: deadline(30_000),
  });
  if (!response.ok) throw await failure(response, `Composio rejected the key (HTTP ${response.status})`);
  const session = (await response.json()) as SessionResponse;
  if (!session.session_id || !session.mcp?.url || !trusted(session.mcp.url))
    throw new Error("Composio returned an unexpected session.");
  return session;
}

async function sessionExists(apiKey: string, sessionId: string): Promise<boolean> {
  const response = await fetch(`${API()}/tool_router/session/${encodeURIComponent(sessionId)}`, {
    headers: headers(apiKey),
    signal: deadline(15_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw await failure(response, `Composio session: HTTP ${response.status}`);
  return true;
}

export async function setKey({ key }: { key: string }) {
  const apiKey = key.trim();
  if (!apiKey.startsWith("ak_")) throw new Error("Composio project keys start with ak_.");
  const state = await readState();
  const session = await createSession(apiKey, state.userId);
  await writeState({ apiKey, sessionId: session.session_id, mcpUrl: session.mcp.url, multiAccount: true });
  forgetCaches();
  return { ok: true };
}

export async function removeKey() {
  await writeState({ apiKey: null, sessionId: null, mcpUrl: null });
  forgetCaches();
  return { ok: true };
}

export async function status() {
  const { apiKey } = await readState();
  return { configured: !!apiKey, keyHint: apiKey ? `ak_…${apiKey.slice(-4)}` : null };
}

export async function session(
  options: { recreate?: boolean } = {},
): Promise<{ apiKey: string; sessionId: string; mcpUrl: string }> {
  const state = await readState();
  if (!state.apiKey) throw new Error("Connected apps aren't set up. Add a Composio key in Skills & Tools.");
  // A session from before several accounts per app were allowed is replaced once.
  const current = !options.recreate && state.multiAccount;
  if (current && state.sessionId && state.mcpUrl)
    return { apiKey: state.apiKey, sessionId: state.sessionId, mcpUrl: state.mcpUrl };
  if (current && state.sessionId && (await sessionExists(state.apiKey, state.sessionId)) && state.mcpUrl) {
    return { apiKey: state.apiKey, sessionId: state.sessionId, mcpUrl: state.mcpUrl };
  }
  const fresh = await createSession(state.apiKey, state.userId);
  await writeState({ sessionId: fresh.session_id, mcpUrl: fresh.mcp.url, multiAccount: true });
  return { apiKey: state.apiKey, sessionId: fresh.session_id, mcpUrl: fresh.mcp.url };
}

let catalogCache: { key: string; at: number; apps: AppCard[] } | null = null;
let connectedCache: { key: string; at: number; accounts: AppAccount[] } | null = null;
const toolsCache = new Map<string, { key: string; at: number; tools: AppTool[] }>();

function forgetCaches() {
  catalogCache = null;
  connectedCache = null;
  toolsCache.clear();
}

function fingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

interface ToolkitItem {
  slug?: string;
  key?: string;
  name?: string;
  no_auth?: boolean;
  logo?: string;
  meta?: { description?: string; logo?: string; app_url?: string };
}

interface PagedRequest {
  apiKey: string;
  url: string;
  params: Record<string, string>;
  timeoutMs: number;
  failed: (response: Response) => Promise<void>;
}

async function* pagedItems<T>(request: PagedRequest): AsyncGenerator<T[]> {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams(request.params);
    if (cursor) params.set("cursor", cursor);
    const response = await fetch(`${request.url}?${params}`, {
      headers: headers(request.apiKey),
      signal: deadline(request.timeoutMs),
    });
    if (!response.ok) return await request.failed(response);
    const body = (await response.json()) as { items?: T[]; next_cursor?: string | null };
    yield body.items ?? [];
    const next = body.next_cursor?.trim();
    if (!next || next === cursor) return;
    cursor = next;
  }
}

function appCard(item: ToolkitItem): AppCard | null {
  const raw = item.slug ?? item.key ?? item.name;
  if (!raw) return null;
  const slug = canonicalSlug(raw);
  return {
    slug,
    name: item.name ?? slug,
    description: (item.meta?.description ?? "").trim(),
    logo: item.meta?.logo ?? item.logo ?? null,
    domain: appDomain(item.meta?.app_url),
    noAuth: item.no_auth === true,
  };
}

export async function catalog(): Promise<{ apps: AppCard[] }> {
  const { apiKey } = await readState();
  if (!apiKey) return { apps: [] };
  const key = fingerprint(apiKey);
  if (catalogCache?.key === key && Date.now() - catalogCache.at < CATALOG_TTL_MS)
    return { apps: catalogCache.apps };
  const apps: AppCard[] = [];
  const seen = new Set<string>();
  const pages = pagedItems<ToolkitItem>({
    apiKey,
    url: `${CATALOG_API()}/toolkits`,
    params: { limit: "500", sort_by: "usage" },
    timeoutMs: 20_000,
    failed: async (response) => {
      // Keep what earlier pages returned; only the first page failing is an error.
      if (apps.length) return;
      throw await failure(response, `Composio catalog: HTTP ${response.status}`);
    },
  });
  for await (const items of pages) {
    for (const card of items.map(appCard)) {
      if (!card || seen.has(card.slug)) continue;
      seen.add(card.slug);
      apps.push(card);
    }
  }
  catalogCache = { key, at: Date.now(), apps };
  return { apps };
}

interface ToolItem {
  slug?: string;
  name?: string;
  tags?: string[];
  is_deprecated?: boolean;
}

function appTool(item: ToolItem): AppTool | null {
  const tags = item.tags ?? [];
  if (!item.slug || item.is_deprecated || tags.includes("mcpIgnore")) return null;
  return {
    slug: item.slug.toUpperCase(),
    name: item.name?.trim() || item.slug,
    readOnly: tags.includes("readOnlyHint"),
  };
}

export async function appTools({ slug }: { slug: string }): Promise<{ tools: AppTool[] }> {
  const { apiKey } = await readState();
  if (!apiKey) return { tools: [] };
  const app = canonicalSlug(slug);
  const key = fingerprint(apiKey);
  const cached = toolsCache.get(app);
  if (cached?.key === key && Date.now() - cached.at < CATALOG_TTL_MS) return { tools: cached.tools };
  const tools: AppTool[] = [];
  const pages = pagedItems<ToolItem>({
    apiKey,
    url: `${CATALOG_API()}/tools`,
    params: { toolkit_slug: app, limit: "200" },
    timeoutMs: 20_000,
    failed: async (response) => {
      throw await failure(response, `Composio tools: HTTP ${response.status}`);
    },
  });
  for await (const items of pages) {
    for (const tool of items.map(appTool)) if (tool) tools.push(tool);
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  toolsCache.set(app, { key, at: Date.now(), tools });
  return { tools };
}

interface AccountItem {
  id?: string;
  status?: string;
  alias?: string | null;
  word_id?: string;
  toolkit?: { slug?: string };
  /** Holds the account's tokens too; only its display name is read. */
  data?: { displayName?: unknown };
}

function appAccount(item: AccountItem): AppAccount | null {
  if (!item.id || !item.toolkit?.slug) return null;
  const name =
    typeof item.data?.displayName === "string" && item.data.displayName.trim()
      ? item.data.displayName.trim().slice(0, 120)
      : null;
  return {
    id: item.id,
    slug: canonicalSlug(item.toolkit.slug),
    status: appStatus(item.status),
    alias: item.alias?.trim() || null,
    name,
    wordId: item.word_id?.trim() || null,
  };
}

/** Newest first. `fresh` skips the cache while a sign-in is pending. */
export async function accounts({ fresh }: { fresh?: boolean } = {}): Promise<{ accounts: AppAccount[] }> {
  const { apiKey, userId } = await readState();
  if (!apiKey) return { accounts: [] };
  const key = fingerprint(apiKey);
  if (!fresh && connectedCache?.key === key && Date.now() - connectedCache.at < CONNECTED_TTL_MS)
    return { accounts: connectedCache.accounts };
  const found: AppAccount[] = [];
  const pages = pagedItems<AccountItem>({
    apiKey,
    url: `${API()}/connected_accounts`,
    params: { limit: "50", user_ids: userId, order_by: "updated_at", order_direction: "desc" },
    timeoutMs: 15_000,
    failed: async (response) => {
      throw await failure(response, `Composio accounts: HTTP ${response.status}`);
    },
  });
  for await (const items of pages) {
    for (const account of items.map(appAccount)) if (account) found.push(account);
  }
  connectedCache = { key, at: Date.now(), accounts: found };
  return { accounts: found };
}

export async function connectedSlugs(): Promise<string[]> {
  const { accounts: list } = await accounts().catch(() => ({ accounts: [] as AppAccount[] }));
  return [
    ...new Set(list.filter((account) => account.status === "connected").map((account) => account.slug)),
  ];
}

/** The user finishes signing in in their browser; the app polls `accounts`. */
export async function connect({ slug, alias }: { slug: string; alias?: string }) {
  const name = alias?.trim();
  const link = async (sessionId: string, apiKey: string) =>
    fetch(`${API()}/tool_router/session/${encodeURIComponent(sessionId)}/link`, {
      method: "POST",
      headers: headers(apiKey, true),
      body: JSON.stringify({ toolkit: canonicalSlug(slug), ...(name ? { alias: name } : {}) }),
      signal: deadline(30_000),
    });
  let current = await session();
  let response = await link(current.sessionId, current.apiKey);
  if (response.status === 404) {
    current = await session({ recreate: true });
    response = await link(current.sessionId, current.apiKey);
  }
  if (!response.ok) throw await failure(response, `Composio sign-in: HTTP ${response.status}`);
  const body = (await response.json()) as { redirect_url?: string };
  if (!body.redirect_url || !trusted(body.redirect_url))
    throw new Error("Composio returned an unexpected sign-in link.");
  connectedCache = null;
  return { url: body.redirect_url };
}

/** "" clears the alias; aliases are unique per app. */
export async function renameAccount({ accountId, alias }: { accountId: string; alias: string }) {
  const { apiKey } = await readState();
  if (!apiKey) throw new Error("Connected apps aren't set up.");
  const { accounts: mine } = await accounts({ fresh: true });
  if (!mine.some((account) => account.id === accountId))
    throw new Error("That account isn't connected on this host.");
  const response = await fetch(`${CATALOG_API()}/connected_accounts/${encodeURIComponent(accountId)}`, {
    method: "PATCH",
    headers: headers(apiKey, true),
    body: JSON.stringify({ alias: alias.trim() }),
    signal: deadline(15_000),
  });
  if (!response.ok) throw await failure(response, `Composio rename: HTTP ${response.status}`);
  connectedCache = null;
  return { ok: true };
}

/** Refuses accounts that don't belong to this host's Composio user. */
export async function disconnect({ accountId }: { accountId: string }) {
  const { apiKey } = await readState();
  if (!apiKey) throw new Error("Connected apps aren't set up.");
  const { accounts: mine } = await accounts({ fresh: true });
  if (!mine.some((account) => account.id === accountId))
    throw new Error("That account isn't connected on this host.");
  const response = await fetch(
    `${API()}/connected_accounts/${encodeURIComponent(accountId)}?revoke_on_delete=true`,
    {
      method: "DELETE",
      headers: headers(apiKey),
      signal: deadline(15_000),
    },
  );
  if (!response.ok && response.status !== 404)
    throw await failure(response, `Composio disconnect: HTTP ${response.status}`);
  connectedCache = null;
  return { ok: true };
}
