// Composio's Tool Router exposes a few meta-tools over one MCP server instead of every app's tools.

import type { AppRule } from "./bot";
import { serverToolName, toolCallName } from "./tool-name";

/** A library MCP server with this name would shadow it. */
export const APPS_MCP_NAME = "composio";

export interface AppCard {
  slug: string;
  name: string;
  description: string;
  /** Always an SVG. */
  logo: string | null;
  /** For a PNG favicon where SVGs can't be drawn. */
  domain: string | null;
  noAuth: boolean;
}

export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=64`;
}

export function appDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

export interface AppAccount {
  id: string;
  slug: string;
  status: AppStatus;
  alias: string | null;
  /** The provider's sign-in name, usually an email address. */
  name: string | null;
  /** Composio's readable id ("gmail_brave-owl"), which its tool router reports for a new sign-in. */
  wordId: string | null;
}

export function accountLabel(account: Pick<AppAccount, "alias" | "name">, appName: string): string {
  return account.alias ?? account.name ?? appName;
}

export type AppStatus = "connected" | "pending" | "failed";

export function appStatus(status: string | null | undefined, noAuth = false): AppStatus {
  if (noAuth || /^active$/i.test(status ?? "")) return "connected";
  if (/^(initiated|initializing|pending)$/i.test(status ?? "")) return "pending";
  return "failed";
}

/** Composio names the app X "twitter" and prefixes slugs that start with a digit. */
export function canonicalSlug(slug: string): string {
  const lower = slug.trim().toLowerCase();
  return lower === "x" ? "twitter" : lower;
}

export function isComposioUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && (url.hostname === "composio.dev" || url.hostname.endsWith(".composio.dev"))
    );
  } catch {
    return false;
  }
}

/** The longest known slug prefix wins: BLAND_AI_* is bland_ai, not bland. */
export function appForTool(toolSlug: string, knownSlugs: readonly string[]): string | null {
  const name = toolSlug.trim().toUpperCase();
  let best: string | null = null;
  for (const slug of knownSlugs) {
    const prefix = `${slug.toUpperCase()}_`;
    if (name.startsWith(prefix) && (!best || slug.length > best.length)) best = slug;
  }
  return best;
}

export interface AppLimit {
  /** Upper-case; null allows every tool. */
  tools: ReadonlySet<string> | null;
  /** Null lets the bot pick. */
  account: { id: string; alias: string | null } | null;
}

export interface AppAccess {
  allowed: readonly string[];
  /** Signed in on this host; used to tell which app a tool belongs to. */
  connected: readonly string[];
  limits: ReadonlyMap<string, AppLimit>;
}

type ToolEntry = { tool_slug?: unknown; account?: unknown };

interface CallReview {
  apps: Set<string>;
  tools: Set<string>;
  account: string | null;
  pinned: boolean;
}

function checkWorkbench(message: unknown, access: AppAccess): { refusal: string } | { message: unknown } {
  const limited = access.limits.size > 0 || access.connected.some((slug) => !access.allowed.includes(slug));
  return limited
    ? {
        refusal:
          "Composio's remote workbench can run any app's tools, so it's off for bots limited to some apps, tools or accounts. Run tools with COMPOSIO_MULTI_EXECUTE_TOOL.",
      }
    : { message };
}

function pinAccount(
  entry: ToolEntry,
  account: NonNullable<AppLimit["account"]>,
  review: CallReview,
): ToolEntry {
  const asked = typeof entry.account === "string" ? entry.account.trim() : "";
  if (asked && asked !== account.id && asked.toLowerCase() !== account.alias?.toLowerCase())
    review.account = account.alias ?? account.id;
  review.pinned = true;
  return { ...entry, account: account.id };
}

function reviewEntry(entry: ToolEntry, access: AppAccess, review: CallReview): ToolEntry {
  const tool = typeof entry.tool_slug === "string" ? entry.tool_slug.trim().toUpperCase() : "";
  const app = tool ? appForTool(tool, access.connected) : null;
  if (!app) return entry;
  if (!access.allowed.includes(app)) review.apps.add(app);
  const limit = access.limits.get(app);
  if (!limit) return entry;
  if (limit.tools && !limit.tools.has(tool)) review.tools.add(tool);
  return limit.account ? pinAccount(entry, limit.account, review) : entry;
}

function reviewRefusal(review: CallReview): string | null {
  const them = (count: number) => (count === 1 ? "it" : "them");
  if (review.apps.size)
    return `This bot isn't allowed to use ${[...review.apps].join(", ")}. Ask the user to switch ${them(review.apps.size)} on under the bot's Access settings in Paseo.`;
  if (review.tools.size)
    return `This bot isn't allowed to run ${[...review.tools].join(", ")}. Ask the user to allow ${them(review.tools.size)} under the bot's Access settings in Paseo.`;
  if (review.account)
    return `This bot may only use the account "${review.account}" for that app. Leave "account" out to use it.`;
  return null;
}

/** Only tool runs are checked; searching, reading schemas and connecting apps always pass. */
export function checkAppCall(
  message: unknown,
  access: AppAccess,
): { refusal: string } | { message: unknown } {
  const frame = (message ?? {}) as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
  if (frame.method !== "tools/call" || typeof frame.params?.name !== "string") return { message };
  if (/^COMPOSIO_REMOTE_(WORKBENCH|BASH_TOOL)$/.test(frame.params.name))
    return checkWorkbench(message, access);
  if (!/MULTI_EXECUTE_TOOL$|^COMPOSIO_EXECUTE_TOOL$/.test(frame.params.name)) return { message };
  // `{tools: [{tool_slug, account}]}`, or the older single `{tool_slug, account}`.
  const args = (frame.params.arguments ?? {}) as ToolEntry & { tools?: unknown };
  const entries: ToolEntry[] = Array.isArray(args.tools)
    ? args.tools.map((entry) => (entry && typeof entry === "object" ? (entry as ToolEntry) : {}))
    : [args];
  const review: CallReview = { apps: new Set(), tools: new Set(), account: null, pinned: false };
  const next = entries.map((entry) => reviewEntry(entry, access, review));
  const refusal = reviewRefusal(review);
  if (refusal) return { refusal };
  if (!review.pinned) return { message };
  return {
    message: {
      ...frame,
      params: { ...frame.params, arguments: Array.isArray(args.tools) ? { ...args, tools: next } : next[0] },
    },
  };
}

export interface AppTool {
  slug: string;
  name: string;
  readOnly: boolean;
}

export function withAppRule(
  rules: Readonly<Record<string, AppRule>>,
  slug: string,
  rule: AppRule,
): Record<string, AppRule> {
  const next = { ...rules };
  if (rule.tools === "all" && !rule.account) delete next[slug];
  else next[slug] = rule;
  return next;
}

/** A type, not an interface, so it's assignable to timeline JSON. */
export type AppSignIn = {
  slug: string;
  /** Expires ten minutes after the call. */
  url: string;
  wordId: string | null;
  alias: string | null;
};

function parsedResults(value: string, depth: number): Record<string, unknown> | null {
  try {
    return composioResults(JSON.parse(value), depth + 1);
  } catch {
    return null;
  }
}

function recordResults(
  record: { data?: { results?: unknown }; output?: unknown; text?: unknown; content?: unknown },
  depth: number,
): Record<string, unknown> | null {
  const results = record.data?.results;
  if (results && typeof results === "object" && !Array.isArray(results))
    return results as Record<string, unknown>;
  return (
    composioResults(record.output, depth + 1) ??
    composioResults(record.text, depth + 1) ??
    composioResults(record.content, depth + 1)
  );
}

/** Providers wrap Composio's `data.results` as JSON text, content blocks or `{output}`. */
function composioResults(value: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 4) return null;
  if (typeof value === "string") return parsedResults(value, depth);
  if (value === null || typeof value !== "object") return null;
  if (Array.isArray(value))
    return value.reduce<Record<string, unknown> | null>(
      (found, entry) => found ?? composioResults(entry, depth + 1),
      null,
    );
  return recordResults(value, depth);
}

function signInOf(slug: string, value: unknown): AppSignIn | null {
  const result = (value ?? {}) as {
    redirect_url?: unknown;
    accounts?: { id?: unknown; alias?: unknown }[];
  };
  const url = result.redirect_url;
  if (typeof url !== "string" || !isComposioUrl(url)) return null;
  const account = Array.isArray(result.accounts) ? result.accounts[0] : undefined;
  return {
    slug: canonicalSlug(slug),
    url,
    wordId: typeof account?.id === "string" ? account.id : null,
    alias: typeof account?.alias === "string" && account.alias.trim() ? account.alias.trim() : null,
  };
}

/** Output: `{data: {results: {notion: {redirect_url, accounts: [{id, alias}]}}}}`. */
export function appSignIns(call: {
  name: string;
  status: string;
  detail: unknown;
  metadata?: unknown;
}): AppSignIn[] {
  if (
    call.status !== "completed" ||
    serverToolName(toolCallName(call), APPS_MCP_NAME) !== "COMPOSIO_MANAGE_CONNECTIONS"
  )
    return [];
  const results = composioResults((call.detail as { output?: unknown } | null)?.output) ?? {};
  const signIns: AppSignIn[] = [];
  for (const [slug, value] of Object.entries(results)) {
    const signIn = signInOf(slug, value);
    if (signIn) signIns.push(signIn);
  }
  return signIns;
}

export interface PromptApp {
  name: string;
  /** `account` is what Composio takes: the alias, or an unnamed account's id. */
  accounts: { account: string; name: string | null }[];
  tools: AppRule["tools"];
}

function promptAppName(app: PromptApp): string {
  const notes = [
    app.accounts.length > 1
      ? `accounts: ${app.accounts.map((entry) => `"${entry.account}"${entry.name ? ` = ${entry.name}` : ""}`).join(", ")}`
      : null,
    app.tools === "read"
      ? "read-only tools"
      : Array.isArray(app.tools)
        ? `only ${app.tools.join(", ")}`
        : null,
  ].filter(Boolean);
  return notes.length ? `${app.name} (${notes.join("; ")})` : app.name;
}

export function appsPrompt(apps: readonly PromptApp[]): string {
  return [
    `Connected apps are available through the MCP server "${APPS_MCP_NAME}". You may use: ${apps.map(promptAppName).join(", ")}.`,
    "Find a tool with COMPOSIO_SEARCH_TOOLS, read its arguments with COMPOSIO_GET_TOOL_SCHEMAS, then run it with COMPOSIO_MULTI_EXECUTE_TOOL.",
    ...(apps.some((app) => app.accounts.length > 1)
      ? [
          'When an app has several accounts, pass the one to use as "account" in each COMPOSIO_MULTI_EXECUTE_TOOL entry, and ask the user when it isn\'t clear which one they mean.',
        ]
      : []),
    "If a task needs an app that isn't connected, add it with COMPOSIO_MANAGE_CONNECTIONS: the user gets a card in this chat to sign in. Then end your turn; they'll tell you when it's connected.",
  ].join(" ");
}
