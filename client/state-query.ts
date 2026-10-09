import { type QueryClient, queryOptions, replaceEqualDeep } from "@tanstack/react-query";
import type { StateSnapshot } from "../shared/bot";

export const STATE_POLL_MS = 2_000;
const STATE_KEY = ["paseo-bots", "state"] as const;

/** A poll with the same revision keeps the old object, so nothing re-renders. */
export function mergeSnapshot(previous: unknown, next: StateSnapshot): StateSnapshot {
  const old = previous as StateSnapshot | undefined;
  return old?.revision === next.revision ? old : replaceEqualDeep(old, next);
}

/** Polls so changes made outside this app, such as by the control server, show up. */
export function stateQuery(read: () => Promise<StateSnapshot>) {
  return queryOptions({
    queryKey: STATE_KEY,
    queryFn: read,
    refetchInterval: STATE_POLL_MS,
    refetchOnWindowFocus: true,
    structuralSharing: (old: unknown, next: unknown) => mergeSnapshot(old, next as StateSnapshot),
  });
}

/** Cancels a poll under way first, since it would bring back the snapshot before the save. */
export async function showSaved(queryClient: QueryClient, snapshot: StateSnapshot): Promise<void> {
  await queryClient.cancelQueries({ queryKey: STATE_KEY });
  queryClient.setQueryData(STATE_KEY, (old: unknown) => mergeSnapshot(old, snapshot));
}
