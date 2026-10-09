import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll } from "vitest";
import { BotsHost } from "../server/host";
import { type Bot, type BotState, EMPTY_LIBRARY, type Library } from "../shared/bot";

export const NOW = "2026-09-27T00:00:00.000Z";

export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}

export function useTempPaseoHome(prefix: string) {
  let home: string;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), prefix));
    process.env.PASEO_HOME = home;
  });
  afterAll(async () => {
    delete process.env.PASEO_HOME;
    await rm(home, { recursive: true, force: true });
  });
}

export function makeBot(patch: Partial<Bot> = {}): Bot {
  return {
    id: "bot-1",
    name: "Inbox",
    title: "",
    description: "",
    avatar: { seed: "s", palette: null, shape: "circle", imageUrl: null },
    hostId: null,
    provider: "claude",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    soul: "",
    mcpServerIds: [],
    alwaysAllow: [],
    skillIds: [],
    apps: [],
    appRules: {},
    voice: { name: null, readReplies: false },
    contactBots: "ask",
    routines: [],
    playbooks: [],
    cwd: null,
    pinned: false,
    archived: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...patch,
  };
}

export type FakeHost = BotsHost & { values(): Promise<BotState> };

/** `values` can be mutated between calls. */
export function fakeHost(bots: Bot[], library: Library = EMPTY_LIBRARY): FakeHost {
  const values: BotState = { bots, history: [], library };
  const store = { read: async () => ({ values, revision: "1" }) };
  return new BotsHost(store as never) as FakeHost;
}
