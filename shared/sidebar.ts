// Mirrors Paseo's sidebar (protocol/agent-state-bucket.ts, utils/sidebar-agent-state.ts,
// hooks/sidebar-workspaces-view-model.ts) so chats read the same as its workspaces.

export type ChatBucket = "needs_input" | "failed" | "running" | "attention" | "done";

export interface ChatBucketInput {
  status: string;
  pendingPermissions?: readonly unknown[] | null;
  requiresAttention?: boolean | null;
  attentionReason?: string | null;
}

export function chatBucket(agent: ChatBucketInput): ChatBucket {
  if ((agent.pendingPermissions?.length ?? 0) > 0 || agent.attentionReason === "permission")
    return "needs_input";
  if (agent.status === "error" || agent.attentionReason === "error") return "failed";
  if (agent.status === "running") return "running";
  if (agent.requiresAttention) return "attention";
  return "done";
}

/** Unlike Paseo's listing order, running outranks attention so a working bot keeps its ring. */
const AGGREGATE_PRIORITY: readonly ChatBucket[] = ["needs_input", "failed", "running", "attention", "done"];

export function aggregateBuckets(buckets: Iterable<ChatBucket>): ChatBucket {
  let best = AGGREGATE_PRIORITY.length - 1;
  for (const bucket of buckets) {
    const rank = AGGREGATE_PRIORITY.indexOf(bucket);
    if (rank !== -1 && rank < best) best = rank;
  }
  return AGGREGATE_PRIORITY[best] ?? "done";
}

export const BUCKET_LABELS: Record<ChatBucket, string> = {
  needs_input: "Needs input",
  failed: "Failed",
  attention: "Ready to review",
  running: "Working",
  done: "Done",
};

/** Groups longer than this get "Show more". */
export const SIDEBAR_GROUP_LIMIT = 20;

function storedKeysPresent<T>(byKey: ReadonlyMap<string, T>, storedOrder: readonly string[]): string[] {
  const pruned: string[] = [];
  const seen = new Set<string>();
  for (const key of storedOrder) {
    if (!byKey.has(key) || seen.has(key)) continue;
    seen.add(key);
    pruned.push(key);
  }
  return pruned;
}

/** Stored keys fill their own slots, so new items never reshuffle the ones the user arranged. */
export function applyStoredOrdering<T>(
  items: readonly T[],
  storedOrder: readonly string[],
  getKey: (item: T) => string,
): T[] {
  if (items.length <= 1 || storedOrder.length === 0) return [...items];
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(getKey(item), item);
  const pruned = storedKeysPresent(byKey, storedOrder);
  if (pruned.length === 0) return [...items];
  const seen = new Set(pruned);
  const ordered: T[] = [];
  let index = 0;
  for (const item of items) {
    const key = getKey(item);
    if (!seen.has(key)) {
      ordered.push(item);
      continue;
    }
    const target = pruned[index] ?? key;
    index += 1;
    ordered.push(byKey.get(target) ?? item);
  }
  return ordered;
}

export type ChatSort = "manual" | "activity";

export interface OrderableChat {
  id: string;
  createdAt: string;
  updatedAt: string;
}

/** "manual" starts from creation order, so rows don't jump when a chat gets a reply. */
export function orderChats<T extends OrderableChat>(
  chats: readonly T[],
  sort: ChatSort,
  storedOrder: readonly string[] = [],
): T[] {
  if (sort === "activity")
    return [...chats].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const base = [...chats].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return applyStoredOrdering(base, storedOrder, (chat) => chat.id);
}

/** `keys` is the full visible order. */
export function moveKey(keys: readonly string[], key: string, delta: -1 | 1): string[] | null {
  const index = keys.indexOf(key);
  const target = index + delta;
  const swapped = keys[target];
  if (index === -1 || swapped === undefined) return null;
  const next = [...keys];
  next[index] = swapped;
  next[target] = key;
  return next;
}
