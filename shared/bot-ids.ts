import { prefixedId } from "./uuid";

export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

export function newBotId(): string {
  return prefixedId("bot");
}

export function newGroupId(): string {
  return prefixedId("team");
}

export function numberedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

export function newPlaybookId(): string {
  return prefixedId("pb");
}

export function newRoutineId(): string {
  return prefixedId("rt");
}
