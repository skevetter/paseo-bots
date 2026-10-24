import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { launchPreparedChat, startChat } from "../server/chats";
import { BotsHost } from "../server/host";
import { LocalChatStarts, type LocalChatStartsOptions, registerLocalStarts } from "../server/local-starts";
import { Relay } from "../server/relay";
import { RunArtifacts } from "../server/run-artifacts";
import { type CoordinatorOptions, RunCoordinator } from "../server/run-coordinator";
import { RunStore } from "../server/run-store";
import { BotStore } from "../server/state";
import { askBot } from "../server/tools/bots";
import type { Bot, BotState } from "../shared/bot";
import type { PreparedBotChat } from "../shared/chat";
import {
  chatsStartRpc,
  LocalChatStartResultSchema,
  LocalPreparedPlanSchema,
  runsPrepareRpc,
  runsStartRpc,
} from "../shared/local-start";
import { PolicySchema, unsetOverrides } from "../shared/policies";
import { newUuid } from "../shared/uuid";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";
import { defined, makeBot, NOW } from "./helpers";

interface LocalHarness {
  daemon: FakeDaemon;
  config: BotStore;
  host: BotsHost;
  relay: Relay;
  store: RunStore;
  coordinator: RunCoordinator;
  starts: LocalChatStarts;
  bot: Bot;
}
let home: string;
const cleanups: (() => Promise<void>)[] = [];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "paseo-local-starts-"));
  process.env.PASEO_HOME = home;
});
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  delete process.env.PASEO_HOME;
  await rm(home, { recursive: true, force: true });
});

const input = (
  patch: Record<string, unknown> = {},
): Record<string, unknown> & { botId: string; requestId: string; prompt: string } => ({
  botId: "bot-1",
  requestId: "request-1",
  prompt: "Do the task",
  ...patch,
});
const creates = (daemon: FakeDaemon) =>
  daemon.sent.filter(
    (frame) => frame.type === "agent.create.request" || frame.type === "create_agent_request",
  );

async function harness(
  options: {
    legacy?: boolean;
    features?: Record<string, boolean>;
    starts?: LocalChatStartsOptions;
    coordinator?: CoordinatorOptions;
    bots?: Bot[];
  } = {},
): Promise<LocalHarness> {
  const daemon = await connectFakeDaemon(
    options.features ?? { creationLifecycle: true, agentRequestReceipts: true },
  );
  const bot = makeBot({ executionMode: options.legacy ? "legacy" : "managed", cwd: "/work" });
  const config = new BotStore(join(home, "state.json"));
  await config.update((values) => ({ ...values, bots: options.bots ?? [bot] }));
  const host = new BotsHost(config);
  const relay = new Relay(host, []);
  const store = new RunStore(join(home, "routines.json"));
  const coordinator = new RunCoordinator(host, relay, {
    reconcileIntervalMs: 60_000,
    ...options.coordinator,
    store,
  });
  const starts = new LocalChatStarts(host, relay, coordinator, { creationWaitMs: 2_000, ...options.starts });
  host.bindChatStarts(starts);
  host.attach(daemon.api);
  await coordinator.ready();
  cleanups.push(async () => {
    starts.stop();
    await coordinator.stop();
    await relay.stop();
    await daemon.close();
  });
  return { daemon, config, host, relay, store, coordinator, starts, bot };
}

async function registered(h: LocalHarness) {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  const handle: PluginServerContext["handle"] = (contract, handler) => {
    handlers.set(contract.name, async (input) =>
      contract.output.parse(
        await handler(contract.input.parse(input), { paseo: h.daemon.api } as PluginHandlerContext),
      ),
    );
  };
  registerLocalStarts({ handle } as PluginServerContext, h.host, h.starts);
  const server: Server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const result = await defined(handlers.get((request.url ?? "").slice(1)))(
        JSON.parse(Buffer.concat(chunks).toString()),
      );
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(result));
    } catch {
      response.writeHead(400).end(JSON.stringify({ error: "request refused" }));
    }
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  cleanups.push(() => {
    const closing = Promise.withResolvers<void>();
    server.close((error) => (error ? closing.reject(error) : closing.resolve()));
    return closing.promise;
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP fixture address missing");
  return async (name: string, body: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}/${name}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error("request refused");
    return response.json();
  };
}

describe("local managed admission", () => {
  it("publishes durable private input before a registered HTTP start creates exactly the chosen SDK identity", async () => {
    let durable = false;
    const h = await harness({
      coordinator: {
        launch: async (host, relay, prepared, options) => {
          const state = await new RunStore(join(home, "routines.json")).read();
          const run = defined(
            Object.values(state.routines)
              .flatMap((record) => record.runs)
              .find((run) => run.agentId === prepared.agentId),
          );
          expect(run.executionStatus).toBe("starting");
          expect(run.managed?.reservation).toBe(true);
          const artifact = await new RunArtifacts(home).get<{ prepared: PreparedBotChat }>(
            defined(run.managed).artifact,
          );
          expect(artifact.prepared.agentId).toBe(prepared.agentId);
          durable = true;
          return launchPreparedChat(host, relay, prepared, options);
        },
      },
    });
    const call = await registered(h);
    const agentId = newUuid();
    const request = input({
      agentId,
      idempotencyKey: "private-host-key",
      env: { SECRET: "private-env" },
      clientMessageId: "client-message",
      purpose: "evaluation",
      outputSchema: { type: "object" },
      images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
      attachments: [
        { type: "text", mimeType: "text/plain", title: "private-title", text: "private-attachment" },
      ],
    });
    const prepared = LocalPreparedPlanSchema.parse(await call(runsPrepareRpc.name, request));
    expect(prepared.plannedAgentId).toBe(agentId);
    expect(creates(h.daemon)).toEqual([]);
    const created = LocalChatStartResultSchema.parse(
      await call(runsStartRpc.name, { planId: prepared.planId }),
    );
    expect(created).toMatchObject({
      status: "created",
      mode: "managed",
      agentId,
      planId: prepared.planId,
      run: { purpose: "evaluation" },
    });
    expect(durable).toBe(true);
    expect(creates(h.daemon)).toEqual([
      expect.objectContaining({
        agentId,
        idempotencyKey: "private-host-key",
        env: { SECRET: "private-env" },
        clientMessageId: "client-message",
        outputSchema: { type: "object" },
        images: request.images,
        attachments: request.attachments,
      }),
    ]);
    const replay = LocalChatStartResultSchema.parse(await call(chatsStartRpc.name, request));
    expect(replay.agentId).toBe(agentId);
    expect(creates(h.daemon)).toHaveLength(1);
    for (const secret of [
      "private-env",
      "private-host-key",
      "private-attachment",
      "Authorization",
      "mcpServers",
    ])
      expect(JSON.stringify({ prepared, created, replay })).not.toContain(secret);
  });

  it("hashes complete original fields, including changed tails, attachments, and creation options", async () => {
    const h = await harness();
    const original = input({ title: `${"x".repeat(2_000)}original` });
    const saved = await h.starts.prepare(original);
    for (const patch of [
      { title: `${"x".repeat(2_000)}changed` },
      { prompt: "Do the task!" },
      { attachments: [{ type: "text", mimeType: "text/plain", title: "note", text: "changed" }] },
      { env: { X: "different" } },
      { outputSchema: { type: "string" } },
      { agentId: newUuid() },
      { clientMessageId: "different" },
      { purpose: "maintenance" },
      { images: [{ data: "different", mimeType: "image/png" }] },
    ]) {
      await expect(h.starts.prepare({ ...original, ...patch })).rejects.toMatchObject({
        code: "request_conflict",
      });
    }
    expect(await h.starts.prepare(original)).toEqual(saved);
    expect(creates(h.daemon)).toEqual([]);
  });
});
it("releases capacity after a workspace failure proven to precede agent creation", async () => {
  const h = await harness();
  const list = h.daemon.api.workspaces.list.bind(h.daemon.api.workspaces);
  vi.spyOn(h.daemon.api.workspaces, "list").mockImplementationOnce(async () => {
    await list();
    throw new Error("Workspace access denied");
  });

  const refused = await h.starts.create(input());
  expect(refused.status).toBe("not_created");
  expect(refused.run).toMatchObject({
    executionStatus: "failed",
    taskOutcome: "unknown",
    agentCreationStatus: "not_created",
  });
  const retained = await h.coordinator.get(defined(refused.run).id);
  expect(retained?.managed?.reservation).toBe(false);
  expect(creates(h.daemon)).toEqual([]);

  const next = await h.starts.create(input({ requestId: "next-independent-intent" }));
  expect(next.status).toBe("created");
  expect(next.agentId).not.toBeNull();
  expect(creates(h.daemon)).toHaveLength(1);
});

describe("frozen replay and independent admission", () => {
  it("replays before reading edited, legacy-switched, deleted bot or policy state and starts the frozen model", async () => {
    const h = await harness();
    const bot = unsetOverrides(h.bot, ["model"]);
    await h.config.edit((await h.config.read()).revision, (values) => ({
      ...values,
      bots: [bot],
      globalPolicy: { policyId: "pol-frozen", revision: null },
      policies: [
        PolicySchema.parse({
          id: "pol-frozen",
          revision: 1,
          name: "Frozen",
          createdAt: NOW,
          roles: { executor: { provider: "claude", model: "claude-sonnet-5-5" } },
        }),
      ],
    }));
    const request = input();
    const saved = await h.starts.prepare(request);
    await h.config.edit((await h.config.read()).revision, (values) => ({
      ...values,
      bots: [{ ...bot, executionMode: "legacy", model: "other" }],
      policies: [],
    }));
    expect(await h.starts.prepare(request)).toEqual(saved);
    await h.config.update((values) => ({ ...values, bots: [], globalPolicy: undefined }));
    const values = vi.spyOn(h.host, "values");
    expect(await h.starts.prepare(request)).toEqual(saved);
    const started = await h.starts.create(request);
    expect(started.status).toBe("created");
    expect(values).not.toHaveBeenCalled();
    expect(creates(h.daemon)[0]).toHaveProperty("config.model", "claude-sonnet-5-5");
  });

  it("serializes only the same request and captures the complete state once", async () => {
    const h = await harness({
      bots: [
        makeBot({ executionMode: "managed", cwd: "/work" }),
        makeBot({ id: "bot-2", executionMode: "managed", cwd: "/work" }),
      ],
    });
    const original = h.host.values.bind(h.host);
    const blocked = Promise.withResolvers<void>();
    const entering = Promise.withResolvers<void>();
    let reads = 0;
    h.host.values = async (): Promise<BotState> => {
      reads++;
      if (reads === 1) {
        entering.resolve();
        await blocked.promise;
      }
      return original();
    };
    const first = h.starts.prepare(input());
    await entering.promise;
    const duplicate = h.starts.prepare(input());
    const independent = await h.starts.prepare(input({ botId: "bot-2", requestId: "independent" }));
    expect(independent.run.executionStatus).toBe("queued");
    expect(reads).toBe(2);
    blocked.resolve();
    expect(await duplicate).toEqual(await first);
    expect(reads).toBe(2);
  });
});

describe("creation uncertainty and runtime constraints", () => {
  it("returns pending for a queued second task, never the reserved UUID as a created chat", async () => {
    const h = await harness({ starts: { creationWaitMs: 20 } });
    expect((await h.starts.create(input())).status).toBe("created");
    const queued = await h.starts.create(input({ requestId: "second" }));
    expect(queued).toMatchObject({
      status: "pending",
      agentId: null,
      mode: "managed",
      run: { executionStatus: "queued" },
    });
    expect(queued.plannedAgentId).not.toBeNull();
    expect(creates(h.daemon)).toHaveLength(1);
  });

  it("reports uncertain SDK rejection as pending but typed unsupported-identity rejection as not_created", async () => {
    const h = await harness();
    h.daemon.creation([], "lost response private-host-error");
    const unknown = await h.starts.create(input());
    expect(unknown).toMatchObject({ status: "pending", agentId: null, run: { executionStatus: "unknown" } });
    expect(JSON.stringify(unknown)).not.toContain("private-host-error");
    expect(creates(h.daemon)).toHaveLength(1);
  });

  it("retains routine capacity, resources and purpose in the frozen admission and expires before creation", async () => {
    const routine = {
      id: "rt",
      name: "Task",
      prompt: "go",
      enabled: true,
      schedule: { kind: "webhook" as const },
      createdAt: NOW,
      resultsChatId: null,
      runtime: {
        capacity: { global: 1 },
        resourceIds: ["shared-seat"],
        overlap: "queue" as const,
        deadlineSeconds: 1,
      },
    };
    const h = await harness({
      bots: [makeBot({ executionMode: "managed", cwd: "/work", routines: [routine] })],
      starts: { now: () => 1_000 },
    });
    const prepared = await h.starts.prepare(input({ routineId: "rt", purpose: "maintenance" }));
    const run = defined(await h.coordinator.get(prepared.planId));
    expect(run.managed).toMatchObject({ resourceIds: ["shared-seat"], overlap: "queue", deadlineAt: 2_000 });
    const artifact = await new RunArtifacts(home).get<{ capacity: unknown }>(defined(run.managed).artifact);
    expect(artifact.capacity).toEqual({ global: 1 });
    const started = await h.starts.start(prepared.planId);
    expect(started).toMatchObject({
      status: "not_created",
      agentId: null,
      run: { purpose: "maintenance", executionStatus: "canceled" },
    });
    expect(creates(h.daemon)).toEqual([]);
  });
});

describe("local legacy and colleague boundaries", () => {
  it("refuses managed-only prepare, private prepared input, and remote launch", async () => {
    const h = await harness({ legacy: true });
    await expect(h.starts.prepare(input())).rejects.toThrow("managed");
    await expect(h.starts.create(input({ config: { mcpServers: {} } }))).rejects.toThrow();
    await h.config.update((values) => ({ ...values, bots: [{ ...h.bot, hostId: "other" }] }));
    await expect(h.starts.create(input())).rejects.toThrow("another host");
    expect(creates(h.daemon)).toEqual([]);
    expect((await h.coordinator.list()).runs).toEqual([]);
  });

  it("returns a real legacy SDK receipt without claiming managed accounting", async () => {
    const h = await harness({ legacy: true });
    const agentId = newUuid();
    const started = await startChat(h.host, {
      ...input(),
      agentId,
      env: { PRIVATE: "private" },
      purpose: "maintenance",
    });
    expect(started).toMatchObject({
      status: "created",
      mode: "legacy",
      agentId,
      plannedAgentId: agentId,
      run: null,
      planId: null,
    });
    const retained = (await h.coordinator.list()).runs;
    expect(retained).toEqual([
      expect.objectContaining({
        agentId,
        purpose: "maintenance",
        executionStatus: "running",
        taskOutcome: "unknown",
        agentCreationStatus: "created",
      }),
    ]);
    expect(retained[0]?.managed).toBeUndefined();
  });

  it("proves old-host no-create separately from transport ambiguity in both modes", async () => {
    const h = await harness({ features: {} });
    const result = await h.starts.create(input());
    expect(result).toMatchObject({
      status: "not_created",
      agentId: null,
      run: { taskOutcome: "unknown", agentCreationStatus: "not_created" },
    });
    expect(creates(h.daemon)).toEqual([]);
    await h.config.update((values) => ({ ...values, bots: [{ ...h.bot, executionMode: "legacy" }] }));
    expect(await h.starts.create(input({ requestId: "legacy" }))).toMatchObject({
      status: "not_created",
      mode: "legacy",
      agentId: null,
      planId: null,
    });
  });

  it("keeps typed legacy no-create proof across a mode change without retrying the host", async () => {
    const h = await harness({ legacy: true, features: {} });
    const request = input();
    expect(await h.starts.create(request)).toMatchObject({ status: "not_created", mode: "legacy" });
    expect((await h.coordinator.list()).runs).toEqual([
      expect.objectContaining({
        executionStatus: "failed",
        taskOutcome: "unknown",
        agentCreationStatus: "not_created",
      }),
    ]);
    await h.config.update((values) => ({ ...values, bots: [{ ...h.bot, executionMode: "managed" }] }));
    expect(await h.starts.create(request)).toMatchObject({
      status: "not_created",
      mode: "legacy",
      planId: null,
      run: null,
    });
    await expect(h.starts.prepare(request)).rejects.toThrow("legacy");
    expect(creates(h.daemon)).toEqual([]);
  });
});

describe("abandoned local legacy setup", () => {
  it.each(["timeout", "stop"] as const)(
    "never crosses SDK creation after %s abandons a workspace await",
    async (kind) => {
      const h = await harness({ legacy: true, starts: { legacyTimeoutMs: 5_000 } });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      h.daemon.hold("workspaces");
      const creating = h.starts.create(input());
      await vi.waitFor(() =>
        expect(h.daemon.sent.some((frame) => frame.type === "fetch_workspaces_request")).toBe(true),
      );
      if (kind === "stop") h.starts.stop();
      else await vi.advanceTimersByTimeAsync(5_000);
      expect(await creating).toMatchObject({
        status: "pending",
        agentId: null,
        mode: "legacy",
        planId: null,
      });
      h.daemon.release();
      await setImmediate();
      expect(creates(h.daemon)).toEqual([]);
      h.starts.stop();
      await expect(h.starts.create(input({ requestId: "after-stop" }))).rejects.toThrow("stopped");
    },
  );
});

describe("durable legacy request replay", () => {
  it("retains identity before the SDK call and replays an abandoned reply after mode change and deletion", async () => {
    const h = await harness({ legacy: true });
    const request = input();
    h.daemon.hold();
    const creating = h.starts.create(request);
    await vi.waitFor(() => expect(creates(h.daemon)).toHaveLength(1));
    const retained = Object.values((await new RunStore(join(home, "routines.json")).read()).routines).flatMap(
      (record) => record.runs,
    );
    const run = defined(retained[0]);
    expect(run).toMatchObject({
      executionStatus: "starting",
      taskOutcome: "unknown",
      agentCreationStatus: "unknown",
    });
    expect(run.managed).toBeUndefined();
    expect(creates(h.daemon)[0]).toHaveProperty("agentId", run.agentId);
    h.starts.stop();
    expect(await creating).toMatchObject({
      status: "pending",
      mode: "legacy",
      plannedAgentId: run.agentId,
      agentId: null,
    });
    h.daemon.release();
    await setImmediate();
    const fresh = new LocalChatStarts(h.host, h.relay, h.coordinator);
    cleanups.push(async () => fresh.stop());
    await h.config.update((values) => ({
      ...values,
      bots: [{ ...h.bot, executionMode: "managed", model: "edited" }],
    }));
    expect(await fresh.create(request)).toMatchObject({
      status: "created",
      mode: "legacy",
      agentId: run.agentId,
      run: null,
      planId: null,
    });
    await expect(fresh.prepare(request)).rejects.toThrow("legacy");
    await h.config.update((values) => ({ ...values, bots: [] }));
    const values = vi.spyOn(h.host, "values");
    expect(await fresh.create(request)).toMatchObject({ status: "created", agentId: run.agentId });
    expect(values).not.toHaveBeenCalled();
    await expect(fresh.create({ ...request, prompt: "changed" })).rejects.toMatchObject({
      code: "request_conflict",
    });
    expect(creates(h.daemon)).toHaveLength(1);
  });

  it("keeps an uncertain legacy receipt pending until a matching real host snapshot proves creation", async () => {
    const h = await harness({ legacy: true });
    h.daemon.creation([], "lost create acknowledgement");
    const request = input();
    const unknown = await h.starts.create(request);
    expect(unknown).toMatchObject({ status: "pending", mode: "legacy", agentId: null });
    const planned = defined(unknown.plannedAgentId);
    await h.config.update((values) => ({ ...values, bots: [] }));
    expect(await h.starts.create(request)).toMatchObject({ status: "pending", plannedAgentId: planned });
    h.daemon.setAgent(planned, { labels: { "paseo-bots.bot": "wrong-bot" } });
    expect(await h.starts.create(request)).toMatchObject({ status: "pending", agentId: null });
    h.daemon.setAgent(planned, { labels: { "paseo-bots.bot": "bot-1" } });
    expect(await h.starts.create(request)).toMatchObject({
      status: "created",
      agentId: planned,
      mode: "legacy",
    });
    expect((await h.coordinator.list()).runs[0]).toMatchObject({
      executionStatus: "unknown",
      agentId: planned,
      taskOutcome: "unknown",
      agentCreationStatus: "created",
    });
    expect(creates(h.daemon)).toHaveLength(1);
  });
});

describe("legacy acknowledgement and lifecycle race", () => {
  it("never overwrites a native completion that arrived before the create acknowledgement", async () => {
    const h = await harness({ legacy: true });
    h.daemon.hold();
    const creating = h.starts.create(input());
    await vi.waitFor(() => expect(creates(h.daemon)).toHaveLength(1));
    const run = defined((await h.coordinator.list()).runs[0]);
    await h.coordinator.finishLegacy(run.id, {
      executionStatus: "completed",
      taskOutcome: "unknown",
      endedAt: NOW,
    });
    h.daemon.release();
    expect(await creating).toMatchObject({ status: "created", mode: "legacy", agentId: run.agentId });
    expect(await h.coordinator.get(run.id)).toMatchObject({
      executionStatus: "completed",
      taskOutcome: "unknown",
      agentCreationStatus: "created",
      endedAt: NOW,
    });
  });
});

describe("monotonic legacy creation proof", () => {
  it.each(["transport lost after prompt", "Update the host to use caller-selected creation IDs."])(
    "retains a matching SDK acknowledgement before later rejection: %s",
    async (error) => {
      const h = await harness({ legacy: true });
      const agentId = newUuid();
      const request = input({ agentId });
      h.daemon.creation(
        [
          { kind: "agent", revision: 1, phase: "agent_ready", agentId, workspaceId: "ws-1", error: null },
          {
            kind: "agent",
            revision: 2,
            phase: "failed",
            agentId: null,
            workspaceId: "ws-1",
            failedStage: "prompt",
            outcomeUnknown: error === "transport lost after prompt",
            error,
          },
        ],
        error,
      );
      expect(await h.starts.create(request)).toMatchObject({ status: "created", agentId });
      expect(creates(h.daemon)).toEqual([expect.objectContaining({ agentId })]);
      expect(await h.daemon.api.agents.ref(agentId).refresh()).toBeNull();
      const run = defined((await h.coordinator.list()).runs[0]);
      expect(run).toMatchObject({
        agentId,
        agentCreationStatus: "created",
        taskOutcome: "unknown",
        executionStatus: "unknown",
      });
      h.starts.stop();
      await h.coordinator.stop();
      const coordinator = new RunCoordinator(h.host, h.relay, {
        store: new RunStore(join(home, "routines.json")),
      });
      const starts = new LocalChatStarts(h.host, h.relay, coordinator);
      cleanups.push(async () => {
        starts.stop();
        await coordinator.stop();
      });
      await h.config.update((values) => ({ ...values, bots: [] }));
      expect(await starts.create(request)).toMatchObject({ status: "created", agentId });
      expect(await coordinator.get(run.id)).toMatchObject({
        agentCreationStatus: "created",
        taskOutcome: "unknown",
      });
      expect(creates(h.daemon)).toHaveLength(1);
    },
  );
});

describe("legacy native proof boundaries", () => {
  it("does not promote a wrong-ID SDK acknowledgement", async () => {
    const h = await harness({ legacy: true });
    h.daemon.creation(
      [
        {
          kind: "agent",
          revision: 1,
          phase: "agent_ready",
          agentId: newUuid(),
          workspaceId: null,
          error: null,
        },
      ],
      "transport lost",
    );
    expect(await h.starts.create(input())).toMatchObject({ status: "pending", agentId: null });
    expect((await h.coordinator.list()).runs[0]).toMatchObject({ agentCreationStatus: "unknown" });
  });

  it("uses durable native creation proof when SDK rejection arrives after terminal completion", async () => {
    const h = await harness({ legacy: true });
    h.daemon.creation([], "Update the host to use caller-selected creation IDs.");
    h.daemon.hold();
    const creating = h.starts.create(input());
    await vi.waitFor(() => expect(creates(h.daemon)).toHaveLength(1));
    const run = defined((await h.coordinator.list()).runs[0]);
    await h.coordinator.finishLegacy(run.id, {
      executionStatus: "completed",
      agentCreationStatus: "created",
      taskOutcome: "unknown",
      endedAt: NOW,
    });
    h.daemon.release();
    expect(await creating).toMatchObject({ status: "created", agentId: run.agentId });
    expect(await h.coordinator.get(run.id)).toMatchObject({
      executionStatus: "completed",
      agentCreationStatus: "created",
      taskOutcome: "unknown",
      endedAt: NOW,
    });
  });
});

describe("legacy acknowledgement lifetime", () => {
  it.each(["timeout", "stop"] as const)(
    "persists proof before the SDK settles and fences evidence after %s",
    async (ending) => {
      const h = await harness({ legacy: true, starts: { legacyTimeoutMs: 5_000 } });
      const agentId = newUuid();
      h.daemon.creation([
        { kind: "agent", revision: 1, phase: "agent_ready", agentId, workspaceId: null, error: null },
      ]);
      const release = Promise.withResolvers<void>();
      const create = h.daemon.api.agents.create.bind(h.daemon.api.agents);
      let observer: Parameters<typeof create>[0]["onEvent"];
      vi.spyOn(h.daemon.api.agents, "create").mockImplementation(async (options) => {
        observer = options.onEvent;
        const agent = await create(options);
        await release.promise;
        return agent;
      });
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const creating = h.starts.create(input({ agentId }));
      await vi.waitFor(async () =>
        expect((await h.coordinator.list()).runs[0]?.agentCreationStatus).toBe("created"),
      );
      if (ending === "timeout") await vi.advanceTimersByTimeAsync(5_000);
      else h.starts.stop();
      expect(await creating).toMatchObject({ status: "created", agentId });
      h.starts.stop();
      await h.coordinator.stop();
      const before = await readFile(h.store.path, "utf8");
      observer?.({
        kind: "agent",
        idempotencyKey: `paseo-bots:${agentId}`,
        revision: 2,
        phase: "failed",
        agentId,
        workspaceId: null,
        error: "late SDK failure",
      });
      release.resolve();
      await setImmediate();
      expect(await readFile(h.store.path, "utf8")).toBe(before);
    },
  );
});

describe("independent colleague requests", () => {
  it("asks an independent colleague with its own grant envelope and replays a canonical ID after deletion", async () => {
    const colleague = makeBot({
      id: "bot-colleague",
      name: "Inbox",
      executionMode: "managed",
      cwd: "/work",
      alwaysAllow: ["own-command"],
      contactBots: "allow",
      soul: "private-colleague-instructions",
    });
    const h = await harness({ bots: [colleague] });
    const asker = makeBot({ id: "bot-asker", name: "Asker", alwaysAllow: [] });
    const caller = { bot: asker, host: h.host, relay: h.relay, agentId: newUuid() };
    h.host.chatOf = async () => null;
    const args = { bot: colleague.id, message: "Please help", request_id: "ask-key", wait: false };
    await askBot.run(args, caller);
    const create = defined(creates(h.daemon)[0]);
    expect(create).toMatchObject({ labels: { "paseo-bots.asked-by": asker.id } });
    const run = defined((await h.coordinator.list()).runs[0]);
    const artifact = await new RunArtifacts(home).get<{ prepared: PreparedBotChat }>(
      defined(run.managed).artifact,
    );
    expect(artifact.prepared.metadata.permissionEnvelope.alwaysAllow).toEqual(["own-command"]);
    expect(artifact.prepared.metadata.permissionEnvelope.contactBots).toBe("allow");
    expect(artifact.prepared.config.systemPrompt).toContain("private-colleague-instructions");
    await h.config.update((values) => ({ ...values, bots: [] }));
    await askBot.run(args, caller);
    expect(creates(h.daemon)).toHaveLength(1);
    await expect(askBot.run({ ...args, message: "Changed" }, caller)).rejects.toMatchObject({
      code: "request_conflict",
    });
  });

  it("caps the entire colleague creation and answer path to its existing tool budget", async () => {
    const h = await harness();
    const asker = makeBot({ id: "bot-asker" });
    h.host.chatOf = async () => null;
    const create = vi
      .spyOn(h.starts, "create")
      .mockImplementation(() => Promise.withResolvers<never>().promise);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const asking = askBot.run(
      { bot: "bot-1", message: "Help", request_id: "bounded" },
      { bot: asker, host: h.host, relay: h.relay, agentId: newUuid() },
    );
    await vi.advanceTimersByTimeAsync(50_000);
    const result = await asking;
    expect(result).toContain("Accepted/pending request bounded");
    expect(result).not.toContain("in chat");
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe("caller-selected identity", () => {
  it.each([true, false])(
    "refuses a pre-existing native bot chat before admission (legacy=%s)",
    async (legacy) => {
      const h = await harness({ legacy });
      const agentId = newUuid();
      h.daemon.setAgent(agentId, { labels: { "paseo-bots.bot": "bot-1" } });
      await expect(h.starts.create(input({ agentId }))).rejects.toThrow("already exists");
      expect(creates(h.daemon)).toEqual([]);
      expect((await h.coordinator.list()).runs).toEqual([]);
    },
  );

  it("never treats an uncertain native identity inspection as proof that the ID is unused", async () => {
    const h = await harness({ legacy: true, starts: { legacyTimeoutMs: 5_000 } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.daemon.hold("agents");
    const creating = h.starts.create(input({ agentId: newUuid() })).catch((error: unknown) => error);
    await vi.waitFor(() =>
      expect(h.daemon.sent.some((frame) => frame.type === "fetch_agent_request")).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await creating).toBeInstanceOf(Error);
    h.daemon.release();
    await setImmediate();
    expect(creates(h.daemon)).toEqual([]);
    expect((await h.coordinator.list()).runs).toEqual([]);
  });
});

describe("authoritative UUID ownership", () => {
  it("refuses a second request while the first SDK create is held and native refresh is absent", async () => {
    const h = await harness({ legacy: true });
    const agentId = newUuid();
    const first = input({ agentId, requestId: "owner-a", idempotencyKey: "host-a" });
    const other = input({
      agentId,
      requestId: "owner-b",
      idempotencyKey: "host-b",
      prompt: "Different workload",
    });
    h.daemon.hold();
    const creating = h.starts.create(first);
    await vi.waitFor(() => expect(creates(h.daemon)).toHaveLength(1));
    expect(await h.daemon.api.agents.ref(agentId).refresh()).toBeNull();
    let refused: unknown;
    const competing = h.starts.create(other).catch((error: unknown) => {
      refused = error;
      return error;
    });
    await vi.waitFor(async () =>
      expect(refused instanceof Error || (await h.coordinator.list()).runs.length === 2).toBe(true),
    );
    h.daemon.release();
    await creating;
    await competing;
    expect(refused).toBeInstanceOf(Error);
    expect(creates(h.daemon)).toHaveLength(1);
    expect((await h.coordinator.list()).runs.map((run) => run.agentId)).toEqual([agentId]);
    h.starts.stop();
    await h.coordinator.stop();
    h.daemon.setAgent(agentId, null);
    const coordinator = new RunCoordinator(h.host, h.relay, {
      store: new RunStore(join(home, "routines.json")),
    });
    const starts = new LocalChatStarts(h.host, h.relay, coordinator);
    cleanups.push(async () => {
      starts.stop();
      await coordinator.stop();
    });
    await expect(starts.create(other)).rejects.toThrow("already admitted");
    await h.config.update((values) => ({ ...values, bots: [] }));
    expect(await starts.create(first)).toMatchObject({ status: "created", agentId });
    await expect(starts.create({ ...first, prompt: "changed" })).rejects.toMatchObject({
      code: "request_conflict",
    });
    expect(creates(h.daemon)).toHaveLength(1);
  });

  it("retains an unknown request's UUID across timeout and reopening", async () => {
    const h = await harness({ legacy: true, starts: { legacyTimeoutMs: 5_000 } });
    const agentId = newUuid();
    const first = input({ agentId });
    h.daemon.hold();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const creating = h.starts.create(first);
    await vi.waitFor(() => expect(creates(h.daemon)).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await creating).toMatchObject({ status: "pending", plannedAgentId: agentId });
    h.starts.stop();
    await h.coordinator.stop();
    const coordinator = new RunCoordinator(h.host, h.relay, {
      store: new RunStore(join(home, "routines.json")),
    });
    const starts = new LocalChatStarts(h.host, h.relay, coordinator);
    cleanups.push(async () => {
      starts.stop();
      await coordinator.stop();
    });
    await expect(starts.create(input({ agentId, requestId: "another" }))).rejects.toThrow("already admitted");
    expect(await starts.create(first)).toMatchObject({ status: "pending", plannedAgentId: agentId });
    expect(creates(h.daemon)).toHaveLength(1);
    expect((await coordinator.list()).runs).toEqual([
      expect.objectContaining({ agentId, agentCreationStatus: "unknown", executionStatus: "unknown" }),
    ]);
    h.daemon.release();
    await setImmediate();
  });
});
