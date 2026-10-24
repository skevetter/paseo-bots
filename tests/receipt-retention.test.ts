import { describe, expect, it } from "vitest";
import { newOperation } from "../server/operations";
import {
  acceptProposal,
  createProposal,
  dismissProposal,
  getProposal,
  recoverProposals,
} from "../server/proposals";
import { applyOperation, checkedReceipt, completeOperation } from "../shared/changes/operation";
import { MAX_RECEIPTS } from "../shared/changes/receipt";
import { makeBot, useTempPaseoHome } from "./helpers";
import { commands, routineProposal, seeded } from "./replay-fixtures";

it("refuses overflow before applying, preserves every pinned receipt, and admits work after completion", () => {
  let values = { bots: [makeBot()], history: [] } as Parameters<typeof applyOperation>[0];
  const operations = Array.from({ length: MAX_RECEIPTS }, (_, index) => ({
    ...newOperation({ id: `pinned-${index}`, kind: "fixture", body: index }),
    pending: true,
  }));
  for (const operation of operations)
    values = applyOperation(values, operation, (current) => ({ values: current })).values;
  const next = newOperation({ id: "overflow", kind: "fixture", body: "new work" });
  expect(() =>
    applyOperation(values, next, () => {
      throw new Error("callback must not run");
    }),
  ).toThrow("All application receipts are unresolved");
  expect(values.receipts?.map((receipt) => receipt.operationId)).toEqual(
    operations.map((operation) => operation.id),
  );
  const oldest = operations[0];
  if (!oldest) throw new Error("Missing fixture");
  expect(
    applyOperation(values, oldest, () => {
      throw new Error("must not replay");
    }).status,
  ).toBe("replayed");
  expect(() => completeOperation(values, { ...oldest, bodyHash: "changed" })).toThrow("different content");
  const released = completeOperation(values, oldest);
  const admitted = applyOperation(released, next, (current) => ({ values: current }));
  expect(admitted.values.receipts).toHaveLength(MAX_RECEIPTS);
  expect(checkedReceipt(admitted.values, next)?.operationId).toBe("overflow");
  expect(checkedReceipt(admitted.values, oldest)).toBeUndefined();
});

describe("completion interrupted after the durable acceptance mark", () => {
  useTempPaseoHome("paseo-bots-completion-");

  it("releases the pin at startup without rerunning the accepted proposal", async () => {
    const store = await seeded();
    const proposal = await routineProposal();
    await expect(
      acceptProposal(proposal.id, {
        commands,
        store: {
          read: () => store.read(),
          apply: (operation, run) => store.apply(operation, run),
          reconcileOperation: (operation, run) => store.reconcileOperation(operation, run),
          completeOperation: async () => {
            throw new Error("crash after accept mark");
          },
        },
      }),
    ).rejects.toThrow("crash after accept mark");
    expect((await getProposal(proposal.id))?.status).toBe("accepted");
    const before = (await store.read()).values;
    expect(before.pendingOperations).toEqual([proposal.id]);
    await recoverProposals(store);
    const after = (await store.read()).values;
    expect(after.pendingOperations).toBeUndefined();
    expect(after.bots).toEqual(before.bots);
    expect(after.receipts).toEqual(before.receipts);
  });

  it("does not let a client or updater erase unresolved receipt pins", async () => {
    const store = await seeded();
    const operation = { ...newOperation({ id: "protected", kind: "fixture", body: 1 }), pending: true };
    await store.apply(operation, (values) => ({ values }));
    const snapshot = await store.read();
    const { pendingOperations: _pins, receipts: _receipts, ...bare } = snapshot.values;
    await store.write(snapshot.revision, bare);
    await store.update(() => ({ ...bare, pendingOperations: ["forged"] }));
    expect((await store.read()).values.pendingOperations).toEqual([operation.id]);
    expect(checkedReceipt((await store.read()).values, operation)?.operationId).toBe(operation.id);
  });
});

describe("bounded proposal retention", () => {
  useTempPaseoHome("paseo-bots-proposal-cap-");

  it("refuses new proposals rather than dropping pending work, evicting only a resolved record", async () => {
    const store = await seeded();
    const pending = await routineProposal();
    const filler = [];
    for (let index = 1; index < MAX_RECEIPTS; index++) {
      filler.push(
        await createProposal({
          botId: "bot-a",
          agentId: "",
          kind: "command",
          data: { command: `echo ${index}`, cwd: "/tmp" },
        }),
      );
    }
    await expect(routineProposal()).rejects.toThrow();
    expect((await getProposal(pending.id))?.status).toBe("pending");
    const dismissed = filler[0];
    if (!dismissed) throw new Error("Missing fixture");
    await dismissProposal(dismissed.id, store);
    const admitted = await routineProposal();
    expect((await getProposal(admitted.id))?.status).toBe("pending");
    expect(await getProposal(dismissed.id)).toBeNull();
    expect((await getProposal(pending.id))?.status).toBe("pending");
  });
});
