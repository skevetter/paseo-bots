import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Relay } from "../server/relay";
import { RunCoordinator } from "../server/run-coordinator";
import { RunStore } from "../server/run-store";
import { HostCapabilityError } from "../shared/host-capability";
import { makePrepared } from "./coordinator-fixture";
import { defined, fakeHost, makeBot } from "./helpers";

let directory: string;
let coordinator: RunCoordinator;
let launches: string[];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "paseo-original-coordinator-"));
  launches = [];
  const host = fakeHost([makeBot({ executionMode: "managed" })]);
  coordinator = new RunCoordinator(host, new Relay(host, []), {
    store: new RunStore(join(directory, "routines.json")),
    launch: async (_host, _relay, prepared) => {
      launches.push(prepared.agentId);
      return prepared.agentId;
    },
  });
  host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as never);
  await coordinator.ready();
});
afterEach(async () => {
  await coordinator.stop();
  await rm(directory, { recursive: true, force: true });
});
const request = (requestId: string) => ({
  trigger: "manual" as const,
  due: new Date(),
  routineId: "rt",
  requestId,
});

describe("original durable coordinator boundaries", () => {
  it("conflicts on the same request identity with another original body", async () => {
    await coordinator.admitPrepared(makePrepared({ prompt: "First payload" }), {
      ...request("same"),
      requestHash: "a".repeat(64),
    });
    await expect(
      coordinator.admitPrepared(makePrepared({ prompt: "Changed payload" }), {
        ...request("same"),
        requestHash: "b".repeat(64),
      }),
    ).rejects.toMatchObject({ code: "request_conflict" });
  });
  it("does not launch a prepared plan until explicit start intent", async () => {
    const input = { ...request("prepared"), deferLaunch: true };
    const run = await coordinator.admitPrepared(makePrepared(), input);
    expect(run.executionStatus).toBe("queued");
    expect(launches).toEqual([]);
  });
  it("releases deterministic unsupported creation capability without transient retry", async () => {
    const host = fakeHost([makeBot({ executionMode: "managed" })]);
    await coordinator.stop();
    coordinator = new RunCoordinator(host, new Relay(host, []), {
      store: new RunStore(join(directory, "routines.json")),
      launch: async () => {
        throw new HostCapabilityError("managed-identity");
      },
    });
    host.attach({ agents: { ref: () => ({ refresh: async () => null }) } } as never);
    await coordinator.ready();
    const admitted = await coordinator.admitPrepared(makePrepared(), request("unsupported"));
    const receipt = await coordinator.waitForCreation(admitted.id, { timeoutMs: 5_000 });
    expect(receipt.status).toBe("not_created");
    const run = defined(await coordinator.get(admitted.id));
    expect(run.executionStatus).toBe("failed");
    expect(run.taskOutcome).toBe("unknown");
    expect(run.agentCreationStatus).toBe("not_created");
    expect(run.managed?.reservation).toBe(false);
    expect(run.managed?.attempts).toHaveLength(1);
  });
});
