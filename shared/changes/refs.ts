import type { Bot, BotState, Library } from "../bot";

interface RefKind<T> {
  what: string;
  id: (item: T) => string;
  name: (item: T) => string;
}

export function byRef<T>(items: readonly T[], ref: string, kind: RefKind<T>): T {
  const wanted = ref.trim();
  const exact = items.find((item) => kind.id(item) === wanted);
  if (exact) return exact;
  const key = wanted.toLowerCase();
  const named = items.filter((item) => kind.name(item).trim().toLowerCase() === key);
  const [only] = named;
  if (only && named.length === 1) return only;
  if (named.length > 1) throw new Error(`${named.length} ${kind.what}s are called "${wanted}". Use the id.`);
  const known = items.map(kind.name).filter(Boolean);
  throw new Error(
    `There's no ${kind.what} called "${wanted}".${known.length ? ` There are: ${known.slice(0, 30).join(", ")}.` : ""}`,
  );
}

export const ROUTINE_REF: RefKind<Bot["routines"][number]> = {
  what: "routine",
  id: (routine) => routine.id,
  name: (routine) => routine.name,
};

export const findBot = (values: BotState, ref: string) =>
  byRef(values.bots, ref, { what: "bot", id: (bot) => bot.id, name: (bot) => bot.name });
export const findTeam = (values: BotState, ref: string) =>
  byRef(values.groups ?? [], ref, { what: "team", id: (group) => group.id, name: (group) => group.name });
export const findSkill = (library: Library, ref: string) =>
  byRef(library.skills, ref, { what: "skill", id: (skill) => skill.id, name: (skill) => skill.id });
export const findServer = (library: Library, ref: string) =>
  byRef(library.mcpServers, ref, {
    what: "MCP server",
    id: (server) => server.id,
    name: (server) => server.name,
  });
