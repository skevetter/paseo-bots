export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name}-${n}`)) return `${name}-${n}`;
}

export function newBotId(): string {
  return `bot-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newGroupId(): string {
  return `team-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function numberedName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

export function newPlaybookId(): string {
  return `pb-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newRoutineId(): string {
  return `rt-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
