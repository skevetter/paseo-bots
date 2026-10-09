import type { LibraryMcpServer } from "../../shared/bot";

/** A list row's trailing status; a plain note also mutes the row. */
export interface ListNote {
  text: string;
  tone?: "busy" | "danger";
}

export function mcpServerNote(
  server: Pick<LibraryMcpServer, "enabled" | "checkError">,
  testing: boolean,
): ListNote | undefined {
  if (testing) return { text: "Testing...", tone: "busy" };
  if (server.checkError) return { text: "Couldn't connect", tone: "danger" };
  return server.enabled ? undefined : { text: "Off" };
}

export function withMember(set: ReadonlySet<string>, id: string, on: boolean): ReadonlySet<string> {
  if (set.has(id) === on) return set;
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
}

interface QueryState {
  isLoading: boolean;
  error: unknown;
}

export type AppsLoad =
  | { kind: "loading" }
  | { kind: "failed"; label: string; error: unknown }
  | { kind: "not-set-up" }
  | { kind: "ready" };

/** Where the Composio queries stand; a failed catalog still lists apps by slug. */
export function appsLoad(
  status: QueryState & { data?: { configured: boolean } },
  accounts: QueryState,
  catalog: QueryState,
): AppsLoad {
  if (status.isLoading) return { kind: "loading" };
  if (status.error) return { kind: "failed", label: "Couldn't check Composio", error: status.error };
  if (!status.data?.configured) return { kind: "not-set-up" };
  if (accounts.isLoading || catalog.isLoading) return { kind: "loading" };
  if (accounts.error)
    return { kind: "failed", label: "Couldn't load your connected apps", error: accounts.error };
  if (catalog.error) return { kind: "failed", label: "Couldn't load the app catalog", error: catalog.error };
  return { kind: "ready" };
}

/** The read-only mode's count, which waits on the app's tool list. */
export function readOnlyToolsHint(
  tools: QueryState & { data?: unknown },
  readOnly: number,
  total: number,
): string | undefined {
  if (tools.data) return `${readOnly} of ${total} tools`;
  if (tools.isLoading) return "Loading tools...";
  return tools.error ? "Couldn't load the tools" : undefined;
}
