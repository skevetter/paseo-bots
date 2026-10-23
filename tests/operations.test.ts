import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pluginDataPath } from "../server/bot-home";
import { hashBody, newOperation } from "../server/operations";
import { BotStore } from "../server/state";
import type { BotState } from "../shared/bot";
import { applyChanges } from "../shared/changes/apply";
import { changeIds } from "../shared/changes/ids";
import { applyOperation, OperationConflictError } from "../shared/changes/operation";
import { MAX_RECEIPTS } from "../shared/changes/receipt";
import type { Change } from "../shared/changes/schema";
import { makeBot, NOW, useTempPaseoHome } from "./helpers";
import { SETUP, seeded } from "./replay-fixtures";

const base: BotState = { bots: [makeBot({ id: "bot-a", name: "Ada" })], history: [] };

const run = (changes: Change[]) => (values: BotState, scope: { now: string; operationId: string }) => ({
  values: applyChanges(values, changes, { ...scope, provider: "claude" }),
});

const ROUTINE: Change[] = [
  {
    type: "add_routine",
    bot: "Ada",
    name: "Daily",
    instructions: "x",
    schedule: { type: "interval", every_minutes: 60 },
  },
];

describe("applying an operation", () => {
  it("makes the same entities with the same ids whenever it runs", () => {
    const at = (iso: string) => newOperation({ id: "op-1", kind: "changes", body: SETUP, at: iso });
    const first = applyOperation(base, at(NOW), run(SETUP));
    const later = applyOperation(base, at("2027-01-01T00:00:00.000Z"), run(SETUP));
    expect(later.receipt.created).toEqual(first.receipt.created);
    const seeds = (values: BotState) => [
      ...values.bots.map((bot) => bot.avatar.seed),
      ...(values.groups ?? []).map((group) => group.logo?.seed),
    ];
    expect(seeds(later.values)).toEqual(seeds(first.values));
    expect(first.receipt.created).toContain("bot:bot-op-1-0-0");
    const other = applyOperation(
      base,
      newOperation({ id: "op-2", kind: "changes", body: SETUP }),
      run(SETUP),
    );
    expect(other.receipt.created.filter((entity) => first.receipt.created.includes(entity))).toEqual([]);
  });

  it("gives each change its own ids", () => {
    const two: Change[] = [
      { type: "create_bot", name: "One" },
      { type: "create_bot", name: "Two" },
    ];
    const { receipt } = applyOperation(base, newOperation({ id: "op", kind: "x", body: two }), run(two));
    expect(receipt.created).toEqual(["bot:bot-op-0-0", "bot:bot-op-1-0"]);
    expect(changeIds("op", 1).id("bot")).toBe("bot-op-1-0");
  });

  it("returns the receipt for the same id and body, and conflicts for another body", () => {
    const operation = newOperation({ id: "op-1", kind: "changes", body: SETUP });
    const first = applyOperation(base, operation, run(SETUP));
    const again = applyOperation(first.values, operation, () => {
      throw new Error("must not run");
    });
    expect(again).toMatchObject({ status: "replayed", receipt: first.receipt });
    expect(again.values).toBe(first.values);
    expect(() =>
      applyOperation(first.values, newOperation({ id: "op-1", kind: "changes", body: [] }), run(SETUP)),
    ).toThrow(OperationConflictError);
  });

  it("hashes the same content the same whatever order its keys come in", () => {
    expect(hashBody({ a: 1, b: { c: [1, 2], d: undefined } })).toBe(hashBody({ b: { c: [1, 2] }, a: 1 }));
    expect(hashBody({ a: [1, 2] })).not.toBe(hashBody({ a: [2, 1] }));
  });

  it("refuses ids that can't go in a folder name", () => {
    expect(() => applyOperation(base, { id: "../x", kind: "k", bodyHash: "h", at: NOW }, run([]))).toThrow(
      "usable operation id",
    );
  });
});

describe("the store applying an operation", () => {
  useTempPaseoHome("paseo-bots-operations-");

  it("runs concurrent calls with one id in turn, and applies the first only", async () => {
    const store = await seeded();
    const operation = newOperation({ id: "op-race", kind: "changes", body: ROUTINE });
    const results = await Promise.all(Array.from({ length: 8 }, () => store.apply(operation, run(ROUTINE))));
    expect(results.map((result) => result.status).sort()).toEqual([
      "applied",
      ...Array.from({ length: 7 }, () => "replayed"),
    ]);
    expect(new Set(results.map((result) => result.snapshot.revision)).size).toBe(1);
    expect((await store.read()).values.bots[0]?.routines).toHaveLength(1);
  });

  it("saves nothing when the changes refuse", async () => {
    const store = await seeded();
    const { revision } = await store.read();
    const bad: Change[] = [{ type: "delete_bot", bot: "Nobody" }];
    await expect(store.apply(newOperation({ id: "op-bad", kind: "x", body: bad }), run(bad))).rejects.toThrow(
      "Nobody",
    );
    expect((await store.read()).revision).toBe(revision);
  });

  it("keeps the newest receipts and drops the oldest past the cap", async () => {
    const store = await seeded();
    const noop: Change[] = [{ type: "set_defaults", contact_bots: "ask" }];
    for (let n = 0; n < MAX_RECEIPTS + 3; n++)
      await store.apply(newOperation({ id: `op-${n}`, kind: "x", body: n }), run(noop));
    const receipts = (await store.read()).values.receipts ?? [];
    expect(receipts).toHaveLength(MAX_RECEIPTS);
    expect(receipts[0]?.operationId).toBe("op-3");
    expect(receipts.at(-1)?.operationId).toBe(`op-${MAX_RECEIPTS + 2}`);
  });

  it("keeps receipts through the app's writes, which can't forge them either", async () => {
    const store = await seeded();
    await store.apply(newOperation({ id: "op-keep", kind: "x", body: 1 }), run(ROUTINE));
    const current = await store.read();
    const { receipts: _gone, ...bare } = current.values;
    expect((await store.write(current.revision, { ...bare, bots: [] })).status).toBe("saved");
    const ids = async () => (await store.read()).values.receipts?.map((receipt) => receipt.operationId);
    expect(await ids()).toEqual(["op-keep"]);

    const forged = { ...bare, receipts: [{ ...current.values.receipts?.[0], operationId: "forged" }] };
    await store.update(() => forged as BotState);
    expect(await ids()).toEqual(["op-keep"]);
  });

  it("loads a state file saved before receipts, and leaves the field out until one exists", async () => {
    const path = join(pluginDataPath(), "state-legacy.json");
    await writeFile(path, JSON.stringify({ version: 1, values: { bots: [], history: [] } }));
    const store = new BotStore(path);
    expect((await store.read()).values.receipts).toBeUndefined();
    await store.update((values) => ({ ...values, bots: [makeBot()] }));
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.version).toBe(1);
    expect(saved.values).not.toHaveProperty("receipts");
  });
});
