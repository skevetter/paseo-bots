import { prefixedId } from "../uuid";

/** Ids end up in folder names and URLs, so an operation's id stays to these. */
export const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What a change calls for when it makes something new: an id, or a seed for a face or logo. */
export interface ChangeIds {
  id(prefix: string): string;
  seed(): string;
}

/**
 * Ids made by one change of one operation: `<prefix>-<operation id>-<change position>-<count>`. The same
 * operation applied again, even after a crash, makes the same ids. The last two parts are numbers, so two
 * operations can't make the same id.
 */
export function changeIds(operationId: string, position: number): ChangeIds {
  if (!OPERATION_ID.test(operationId)) throw new Error(`"${operationId}" isn't a usable operation id.`);
  const counts = new Map<string, number>();
  const next = (prefix: string) => {
    const count = counts.get(prefix) ?? 0;
    counts.set(prefix, count + 1);
    return `${prefix}-${operationId}-${position}-${count}`;
  };
  return { id: next, seed: () => next("seed") };
}

/** For changes nobody can replay, such as a dry run. */
export const RANDOM_IDS: ChangeIds = {
  id: (prefix) => prefixedId(prefix),
  seed: () => Math.random().toString(36).slice(2, 10),
};
