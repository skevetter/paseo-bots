import { createHash } from "node:crypto";
import type { Operation } from "../shared/changes/operation";

/** Objects with their keys in order, so equal content always prints the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]),
  );
}

export function hashBody(body: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(body)) ?? "null", "utf8")
    .digest("hex");
}

/** `body` is everything the operation's outcome depends on besides the state it runs on. */
export function newOperation(input: { id: string; kind: string; body: unknown; at?: string }): Operation {
  return {
    id: input.id,
    kind: input.kind,
    bodyHash: hashBody(input.body),
    at: input.at ?? new Date().toISOString(),
  };
}
