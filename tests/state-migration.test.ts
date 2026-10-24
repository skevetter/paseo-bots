import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import type * as Files from "../server/files";
import { BotStore, configBackupPath } from "../server/state";
import { BotStateSchema } from "../shared/bot";
import { makeBot, useTempPaseoHome } from "./helpers";

// A crash is a write that never lands: the hook makes the next write to one path fail.
const crash = vi.hoisted(() => ({ path: null as string | null }));
vi.mock("../server/files", async (importOriginal) => {
  const actual = await importOriginal<typeof Files>();
  return {
    ...actual,
    writeAtomic: async (path: string, text: string, mode?: number) => {
      if (crash.path === path) {
        crash.path = null;
        throw new Error("the process died");
      }
      return actual.writeAtomic(path, text, mode);
    },
  };
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

let file = 0;
const newPath = () => join(pluginDataPath(), `state-${++file}.json`);

async function fixtureText(): Promise<string> {
  return readFile(join(import.meta.dirname, "fixtures", "state-v1.json"), "utf8");
}

/** Settings that differ from bot to bot, so a migration that mixes them up shows. */
function fleetBot(index: number) {
  const modes = [null, null, null, null, "default"];
  return makeBot({
    id: `bot-${index}`,
    name: `Bot ${index}`,
    provider: index % 2 ? "claude" : "omp",
    model: index % 3 ? `m${index}` : null,
    modeId: modes[index % 5] ?? null,
    thinkingOptionId: index % 7 ? null : "high",
  });
}

describe("moving the state file from version 1 to 3", () => {
  useTempPaseoHome("paseo-bots-migration-");
  beforeAll(() => mkdir(pluginDataPath(), { recursive: true }));

  it("keeps the bots, team, routines and receipts, and backs the old file up with its digest first", async () => {
    const path = newPath();
    const original = await fixtureText();
    await writeFile(path, original);

    const { values } = await new BotStore(path).read();

    const expected = BotStateSchema.parse(JSON.parse(original).values);
    expect(values).toEqual(expected);
    expect(values.receipts?.map((receipt) => receipt.operationId)).toEqual(["op-1"]);
    expect(values.bots.map((bot) => [bot.provider, bot.model, bot.modeId, bot.thinkingOptionId])).toEqual([
      ["claude", "opus", "acceptEdits", "high"],
      ["omp", null, null, null],
    ]);
    // Still explicit: nothing hands a field to a policy, and the defaults still start new bots.
    expect(values.bots.every((bot) => bot.policy === undefined)).toBe(true);
    expect(values.defaults?.approval).toBe("ask");

    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.version).toBe(3);
    const backup = configBackupPath(path, 1);
    expect(await readFile(backup, "utf8")).toBe(original);
    expect(await readFile(`${backup}.sha256`, "utf8")).toBe(
      `${sha256(original)}  state-${file}.json.v1.bak\n`,
    );
  });

  it("changes nothing when it is opened again", async () => {
    const path = newPath();
    await writeFile(path, await fixtureText());
    const first = await new BotStore(path).read();
    const written = await readFile(path, "utf8");
    const backups = await Promise.all(
      [configBackupPath(path, 1), `${configBackupPath(path, 1)}.sha256`].map((p) => stat(p)),
    );

    const again = await new BotStore(path).read();

    expect(again).toEqual(first);
    expect(await readFile(path, "utf8")).toBe(written);
    const after = await Promise.all(
      [configBackupPath(path, 1), `${configBackupPath(path, 1)}.sha256`].map((p) => stat(p)),
    );
    expect(after.map((entry) => entry.mtimeMs)).toEqual(backups.map((entry) => entry.mtimeMs));
  });

  it("leaves version 1 whole when the process dies after the backup and before the new file", async () => {
    const path = newPath();
    const original = await fixtureText();
    await writeFile(path, original);
    crash.path = path;

    await expect(new BotStore(path).read()).rejects.toThrow("the process died");

    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(configBackupPath(path, 1), "utf8")).toBe(original);
    expect(
      (await readdir(pluginDataPath())).filter((name) => name.startsWith(`state-${file}.json.corrupt`)),
    ).toEqual([]);

    // The next start finishes the move and the backup still matches what it replaced.
    const { values } = await new BotStore(path).read();
    expect(values.bots).toHaveLength(2);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
    expect(await readFile(configBackupPath(path, 1), "utf8")).toBe(original);
  });

  it("refuses a partial version 1 backup before replacing the source", async () => {
    const path = newPath();
    const original = await fixtureText();
    const partial = original.slice(0, 40);
    await writeFile(path, original);
    await writeFile(configBackupPath(path, 1), partial);

    await expect(new BotStore(path).read()).rejects.toThrow("Durable publication refused");

    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(configBackupPath(path, 1), "utf8")).toBe(partial);
  });

  it("refuses future versions on every read and write without initializing an empty configuration", async () => {
    const path = newPath();
    const future = JSON.stringify({ version: 4, values: { bots: [makeBot()], history: [] } });
    await writeFile(path, future);
    const store = new BotStore(path);

    await expect(store.read()).rejects.toThrow("Unsupported file version 4");
    await expect(new BotStore(path).read()).rejects.toThrow("Unsupported file version 4");
    await expect(store.write("missing", { bots: [], history: [] })).rejects.toThrow(
      "Unsupported file version 4",
    );
    await expect(store.update(() => ({ bots: [], history: [] }))).rejects.toThrow(
      "Unsupported file version 4",
    );

    expect(await readFile(path, "utf8")).toBe(future);
    expect(
      (await readdir(pluginDataPath())).filter((name) => name.startsWith(`state-${file}.json.`)),
    ).toEqual([]);
  });
});

describe("moving the state file from version 2 to 3", () => {
  useTempPaseoHome("paseo-bots-migration-");
  beforeAll(() => mkdir(pluginDataPath(), { recursive: true }));

  it("keeps managed opt-ins and backs the version 2 file up with its digest first", async () => {
    const path = newPath();
    const bot = makeBot({ id: "managed-bot", executionMode: "managed" });
    const original = JSON.stringify({ version: 2, values: { bots: [bot], history: [] } });
    await writeFile(path, original);

    const { values } = await new BotStore(path).read();

    expect(values.bots[0]?.executionMode).toBe("managed");
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(3);
    const backup = configBackupPath(path, 2);
    expect(await readFile(backup, "utf8")).toBe(original);
    expect(await readFile(`${backup}.sha256`, "utf8")).toBe(
      `${sha256(original)}  state-${file}.json.v2.bak\n`,
    );
  });

  it("refuses a divergent version 2 backup before replacing the source", async () => {
    const path = newPath();
    const original = JSON.stringify({ version: 2, values: { bots: [makeBot()], history: [] } });
    const divergent = "someone else's backup\n";
    await writeFile(path, original);
    await writeFile(configBackupPath(path, 2), divergent);

    await expect(new BotStore(path).read()).rejects.toThrow("Durable publication refused");

    expect(await readFile(path, "utf8")).toBe(original);
    expect(await readFile(configBackupPath(path, 2), "utf8")).toBe(divergent);
  });
});

describe("the state file after the move", () => {
  useTempPaseoHome("paseo-bots-migration-");
  beforeAll(() => mkdir(pluginDataPath(), { recursive: true }));

  it("moves a hundred bots with their settings and loses none", async () => {
    const path = newPath();
    const bots = Array.from({ length: 100 }, (_, index) => fleetBot(index));
    const v1 = JSON.stringify({ version: 1, values: { bots, history: [] } });
    await writeFile(path, v1);

    const { values } = await new BotStore(path).read();

    expect(values.bots).toEqual(BotStateSchema.parse({ bots, history: [] }).bots);
    expect(await readFile(configBackupPath(path, 1), "utf8")).toBe(v1);
  });

  it("keeps policies, pending pins and receipts through whole-state writes after the move", async () => {
    const path = newPath();
    await writeFile(path, await fixtureText());
    const store = new BotStore(path);
    const { revision, values } = await store.read();
    const policy = {
      id: "pol-a",
      revision: 1,
      createdAt: "2026-09-27T00:00:00.000Z",
      name: "A",
      purpose: "",
      roles: {},
      budget: {},
      concurrency: {},
    };
    const added = await store.edit(revision, (current) => ({ ...current, policies: [policy] }));
    if (added.status !== "saved") throw new Error("not saved");

    const { policies: _dropped, receipts: _receipts, pendingOperations: _pending, ...bare } = values;
    const wrote = await store.write(added.revision, bare);

    expect(wrote.status).toBe("saved");
    const after = (await store.read()).values;
    expect(after.policies?.map((entry) => entry.id)).toEqual(["pol-a"]);
    expect(after.receipts).toHaveLength(1);
    expect(after.pendingOperations).toEqual(["op-1"]);
  });
});
