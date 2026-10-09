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
