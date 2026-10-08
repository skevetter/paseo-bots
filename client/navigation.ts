import type { LibraryKind } from "../shared/library";

/** `app` ids are connected-app slugs; `apps` is the app catalog. */
export type LibraryTarget = { kind: LibraryKind | "app"; id: string } | { kind: "apps" };

type Listener = (target: LibraryTarget | null) => void;
const listeners = new Set<Listener>();

// Paseo can keep more than one Bots screen mounted, so every listener gets the target.
export function openLibrary(target: LibraryTarget | null = null): void {
  for (const listener of listeners) listener(target);
}

export function onLibraryTarget(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
