import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  PaseoAgentRunResult,
  PaseoWorkspaceAgentCreateOptions,
  PaseoWorkspaceCreateOptions,
} from "@getpaseo/client";
import type { PluginAgentSnapshot } from "@getpaseo/plugin";
import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import { AGENT_LIFECYCLE_STATUSES } from "@getpaseo/protocol/agent-lifecycle";
import {
  type AgentStreamEvent,
  type AgentUsage,
  getAgentStreamEventTurnId,
} from "@getpaseo/protocol/agent-types";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { BOT_LABEL, type BotState, EMPTY_LIBRARY } from "../shared/bot";
import {
  type CreationEvidence,
  launchPreparedBotChat,
  type PreparedBotChat,
  prepareBotChat,
  startBotChat,
} from "../shared/chat";
import { HostCapabilityError, toHostCapabilityError } from "../shared/host-capability";
import { PolicySchema, unsetOverrides } from "../shared/policies";
import { connectFakeDaemon, type FakeDaemon, type Features } from "./fake-daemon";
import { defined, makeBot } from "./helpers";

// These fixtures pin what the installed @getpaseo/client and @getpaseo/plugin do today, so an SDK bump
// that changes it fails here instead of in a user's chat. docs/compatibility.md explains each one.

const root = join(import.meta.dirname, "..");
const MODERN = { creationLifecycle: true, agentRequestReceipts: true };

const workspace = (daemon: FakeDaemon) =>
  daemon.api.workspaces.ref({ id: "ws-1", workspaceDirectory: "/work" } as never);

const CREATE = {
  agentId: "6f1c2a52-9d3e-4c0a-8b7e-3d2f5a1b9c10",
  idempotencyKey: "key-1",
  env: { PLUGIN_SESSION: "s1" },
  clientMessageId: "msg-1",
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
  config: { provider: "claude/claude-sonnet-5-5" },
  prompt: "go",
  title: "A title",
  labels: { "paseo-bots.bot": "bot-1" },
} satisfies PaseoWorkspaceAgentCreateOptions;

let daemon: FakeDaemon;
afterEach(() => daemon.close());

describe("agent create on a host with creationLifecycle", () => {
  it("puts agentId, idempotencyKey, env, clientMessageId and outputSchema on the wire", async () => {
    daemon = await connectFakeDaemon(MODERN);
    const handle = await workspace(daemon).agents.create(CREATE);

    expect(handle.id).toBe("6f1c2a52-9d3e-4c0a-8b7e-3d2f5a1b9c10");
    const [request] = daemon.sent.filter((message) => message.type === "agent.create.request");
    expect(request).toMatchObject({
      agentId: "6f1c2a52-9d3e-4c0a-8b7e-3d2f5a1b9c10",
      idempotencyKey: "key-1",
      env: { PLUGIN_SESSION: "s1" },
      clientMessageId: "msg-1",
      outputSchema: CREATE.outputSchema,
      initialPrompt: "go",
      workspaceId: "ws-1",
      labels: { "paseo-bots.bot": "bot-1" },
      config: { provider: "claude", model: "claude-sonnet-5-5", cwd: "/work", title: "A title" },
    });
  });

  it("shares one request between concurrent calls with the same key and body", async () => {
    daemon = await connectFakeDaemon(MODERN);
    daemon.hold();
    const first = workspace(daemon).agents.create(CREATE);
    const second = workspace(daemon).agents.create(CREATE);
    daemon.release();
    expect((await first).id).toBe((await second).id);
    expect(daemon.sent.filter((message) => message.type === "agent.create.request")).toHaveLength(1);
  });

  it("rejects the same key with a different body while the first call is in flight", async () => {
    daemon = await connectFakeDaemon(MODERN);
    daemon.hold();
    const first = workspace(daemon).agents.create(CREATE);
    const conflicting = workspace(daemon).agents.create({ ...CREATE, prompt: "something else" });
    await expect(conflicting).rejects.toThrow("agent_request_key_conflict");
    daemon.release();
    await first;
  });

  it("forgets a key once its call settles, so the SDK alone gives no durable dedupe", async () => {
    daemon = await connectFakeDaemon(MODERN);
    await workspace(daemon).agents.create(CREATE);
    await workspace(daemon).agents.create(CREATE);
    expect(daemon.sent.filter((message) => message.type === "agent.create.request")).toHaveLength(2);
  });

  it("accepts only a UUID as agentId and rejects anything else before sending", async () => {
    daemon = await connectFakeDaemon(MODERN);
    await expect(workspace(daemon).agents.create({ ...CREATE, agentId: "not-a-uuid" })).rejects.toThrow(
      /uuid/i,
    );
    expect(daemon.sent).toEqual([]);
  });
});

describe("agent create on a host without creationLifecycle", () => {
  it("refuses a caller-selected agentId with an untyped Error and sends nothing", async () => {
    daemon = await connectFakeDaemon({});
    const failure = await workspace(daemon)
      .agents.create(CREATE)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", "Update the host to use caller-selected creation IDs.");
    expect(failure).not.toHaveProperty("code");
    expect(daemon.sent).toEqual([]);
    expect(toHostCapabilityError(failure)).toBeInstanceOf(HostCapabilityError);
    expect(toHostCapabilityError(failure)?.capability).toBe("managed-identity");
  });

  it("refuses a workspace create that names an agentId, through the same error", async () => {
    daemon = await connectFakeDaemon({});
    const failure = await daemon.api.workspaces
      .create({
        title: "Inbox",
        source: { kind: "directory", path: "/work" },
        agent: {
          agentId: "6f1c2a52-9d3e-4c0a-8b7e-3d2f5a1b9c10",
          cwd: "/work",
          config: { provider: "claude/claude-sonnet-5-5" },
        },
      })
      .catch((error: unknown) => error);
    expect(toHostCapabilityError(failure)).toBeInstanceOf(HostCapabilityError);
  });

  it("does not classify other failures as a missing capability", () => {
    expect(toHostCapabilityError(new Error("Update the host to list provider usage."))).toBeNull();
    expect(toHostCapabilityError(new Error("agent_request_key_conflict"))).toBeNull();
    expect(toHostCapabilityError("Update the host to use caller-selected creation IDs.")).toBeNull();
  });

  // Silent degradation the SDK does perform: without an agentId the call succeeds, but the key only
  // reaches the wire when the host has request receipts and the call carries no prompt.
  it.each<{ features: Features; prompt: string | undefined; keyOnWire: boolean }>([
    { features: {}, prompt: "go", keyOnWire: false },
    { features: { agentRequestReceipts: true }, prompt: "go", keyOnWire: false },
    { features: {}, prompt: undefined, keyOnWire: false },
    { features: { agentRequestReceipts: true }, prompt: undefined, keyOnWire: true },
  ])(
    "legacy create with receipts=$features and prompt=$prompt sends idempotencyKey: $keyOnWire",
    async ({ features, prompt, keyOnWire }) => {
      daemon = await connectFakeDaemon(features);
      const { agentId: _agentId, ...withoutAgentId } = CREATE;
      await workspace(daemon).agents.create({ ...withoutAgentId, prompt });

      const [request] = daemon.sent.filter((message) => message.type === "create_agent_request");
      expect("idempotencyKey" in (request ?? {})).toBe(keyOnWire);
      // The other four passthrough fields survive the legacy path.
      expect(request).toMatchObject({
        env: { PLUGIN_SESSION: "s1" },
        clientMessageId: "msg-1",
        outputSchema: CREATE.outputSchema,
        workspaceId: "ws-1",
      });
    },
  );
});

async function admittedRemoteChat() {
  daemon = await connectFakeDaemon(MODERN);
  daemon.setProviders([
    {
      provider: "claude",
      enabled: true,
      status: "ready",
      models: [
        {
          id: "admitted-model",
          label: "Admitted",
          isDefault: true,
          thinkingOptions: [{ id: "high" }],
          defaultThinkingOptionId: "high",
        },
      ],
      modes: [
        { id: "default", label: "Ask" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
      defaultModeId: "default",
    },
  ]);
  const bot = unsetOverrides(
    makeBot({
      hostId: "remote-1",
      mcpServerIds: ["reviewed"],
      alwaysAllow: ["reviewed/read"],
    }),
    ["provider"],
  );
  const library = {
    skills: [],
    mcpServers: [
      {
        id: "reviewed",
        name: "reviewed",
        description: "",
        checkError: null,
        createdAt: "2026-10-23T00:00:00Z",
        updatedAt: "2026-10-23T00:00:00Z",
        enabled: true,
        checkedAt: null,
        tools: null,
        config: { type: "stdio" as const, command: "safe-tool", args: [], env: {} },
      },
    ],
  };
  const policy: BotState = {
    bots: [bot],
    history: [],
    policies: [
      PolicySchema.parse({
        id: "pol-admitted",
        revision: 1,
        createdAt: "2026-10-23T00:00:00Z",
        name: "Admitted",
        roles: { executor: { provider: "claude", model: null } },
      }),
    ],
    globalPolicy: { policyId: "pol-admitted", revision: null },
  };
  const prepared = await prepareBotChat(daemon.api, {
    bot,
    library,
    policy,
    agentId: CREATE.agentId,
    idempotencyKey: CREATE.idempotencyKey,
    env: CREATE.env,
    clientMessageId: CREATE.clientMessageId,
    outputSchema: CREATE.outputSchema,
    placement: { path: "/work", projectRoot: null },
    prompt: "hello",
    systemPrompt: "be brief",
    title: "T".repeat(300),
    labels: {
      "paseo-bots.run": "run-1",
      "paseo-bots.execution": "exe-1",
      "paseo-bots.occurrence": "occ-1",
    },
  });
  return { bot, library, policy, prepared };
}

it("keeps a remote chosen UUID and the admitted model, approval and grants after defaults and policy change", async () => {
  const { bot, library, policy, prepared } = await admittedRemoteChat();
  expect(daemon.sent.map((frame) => frame.type)).toEqual(["get_providers_snapshot_request"]);
  const cold: PreparedBotChat = JSON.parse(JSON.stringify(prepared));
  policy.policies = [
    PolicySchema.parse({
      id: "pol-admitted",
      revision: 2,
      createdAt: "2026-10-23T00:01:00Z",
      name: "Changed",
      roles: { executor: { provider: "claude", model: "new-model" } },
    }),
  ];
  bot.modeId = "bypassPermissions";
  bot.alwaysAllow.push("reviewed/write");
  defined(library.mcpServers[0]).config.command = "unsafe-tool";
  daemon.setProviders([
    {
      provider: "claude",
      enabled: true,
      status: "ready",
      models: [{ id: "new-model", label: "Changed", isDefault: true }],
      defaultModeId: "bypassPermissions",
    },
  ]);

  expect(await launchPreparedBotChat(daemon.api, cold)).toBe(CREATE.agentId);
  const request = daemon.sent.find((frame) => frame.type === "agent.create.request");
  expect(request).toMatchObject({
    agentId: CREATE.agentId,
    idempotencyKey: CREATE.idempotencyKey,
    env: CREATE.env,
    clientMessageId: CREATE.clientMessageId,
    outputSchema: CREATE.outputSchema,
    initialPrompt: "hello",
    labels: {
      [BOT_LABEL]: bot.id,
      "paseo-bots.run": "run-1",
      "paseo-bots.execution": "exe-1",
      "paseo-bots.occurrence": "occ-1",
    },
    config: {
      provider: "claude",
      model: "admitted-model",
      modeId: "default",
      thinkingOptionId: "high",
      title: "T".repeat(200),
      systemPrompt: "be brief",
      mcpServers: { reviewed: { command: "safe-tool" } },
      toolPolicy: { preapproved: [{ kind: "mcp", server: "reviewed", tool: "read" }] },
    },
  });
  expect(daemon.sent.filter((frame) => frame.type === "get_providers_snapshot_request")).toHaveLength(1);
  expect(prepared.config.mcpServers?.reviewed).toMatchObject({ command: "safe-tool" });
});

it("surfaces a typed managed-identity refusal on old remote hosts without creating an unmanaged agent", async () => {
  daemon = await connectFakeDaemon({});
  const failure = await startBotChat(daemon.api, {
    bot: makeBot({ hostId: "remote-old" }),
    library: EMPTY_LIBRARY,
    policy: {},
    agentId: CREATE.agentId,
    idempotencyKey: CREATE.idempotencyKey,
    placement: { path: "/work", projectRoot: null },
    prompt: "hello",
    systemPrompt: "s",
  }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HostCapabilityError);
  expect(failure).toHaveProperty("capability", "managed-identity");
  expect(daemon.sent.map((frame) => frame.type)).toEqual([
    "get_providers_snapshot_request",
    "fetch_workspaces_request",
  ]);
});

it("retains unknown creation outcome and nullable repeated IDs when the SDK discards structured failure", async () => {
  daemon = await connectFakeDaemon(MODERN);
  daemon.creation(
    [
      { kind: "agent", revision: 1, phase: "accepted", agentId: null, workspaceId: null, error: null },
      { kind: "agent", revision: 2, phase: "agent_ready", agentId: null, workspaceId: null, error: null },
      {
        kind: "agent",
        revision: 3,
        phase: "failed",
        agentId: CREATE.agentId,
        workspaceId: null,
        error: "transport lost after submission",
        failedStage: "prompt",
        errorCode: "lost",
        outcomeUnknown: true,
      },
    ],
    "transport lost after submission",
  );
  const observed: CreationEvidence[] = [];
  const prepared = await prepareBotChat(daemon.api, {
    bot: makeBot(),
    library: EMPTY_LIBRARY,
    policy: {},
    agentId: CREATE.agentId,
    idempotencyKey: CREATE.idempotencyKey,
    placement: { path: "/work", projectRoot: null },
    prompt: "hello",
    systemPrompt: "s",
    onEvent: (event) => observed.push(event),
  });
  expect(JSON.stringify(prepared)).not.toContain("onEvent");
  const failure = await launchPreparedBotChat(daemon.api, prepared, (event) => observed.push(event)).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect(failure).not.toHaveProperty("outcomeUnknown");
  expect(observed.map((event) => [event.revision, event.agentId, event.workspaceId])).toEqual([
    [1, null, null],
    [2, null, null],
    [3, CREATE.agentId, null],
  ]);
  expect(observed[2]).toMatchObject({
    idempotencyKey: CREATE.idempotencyKey,
    outcomeUnknown: true,
    failedStage: "prompt",
    errorCode: "lost",
  });
});

describe("SDK types the plugin relies on", () => {
  it("accepts the five create passthrough fields on a workspace agent create", () => {
    type Options = PaseoWorkspaceAgentCreateOptions;
    expectTypeOf<Options["agentId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Options["idempotencyKey"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Options["clientMessageId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<Options["outputSchema"]>().toEqualTypeOf<Record<string, unknown> | undefined>();
    expectTypeOf<Options["env"]>().toEqualTypeOf<Record<string, string> | undefined>();
    expectTypeOf<Options>().not.toHaveProperty("cwd");
  });

  it("offers no idempotencyKey or requestId on the agent that workspaces.create starts", () => {
    type Agent = NonNullable<PaseoWorkspaceCreateOptions["agent"]>;
    expectTypeOf<Agent>().toHaveProperty("agentId");
    expectTypeOf<Agent>().not.toHaveProperty("idempotencyKey");
    expectTypeOf<Agent>().not.toHaveProperty("requestId");
  });

  it("keeps the agent lifecycle and turn outcome vocabularies", () => {
    expect(AGENT_LIFECYCLE_STATUSES).toEqual(["initializing", "idle", "running", "error", "closed"]);
    expectTypeOf<PluginAgentSnapshot["status"]>().toEqualTypeOf<(typeof AGENT_LIFECYCLE_STATUSES)[number]>();
    expectTypeOf<PluginTurnOutcome["kind"]>().toEqualTypeOf<"completed" | "failed" | "canceled">();
    expectTypeOf<PaseoAgentRunResult["status"]>().toEqualTypeOf<
      "idle" | "error" | "permission" | "timeout"
    >();
  });

  it("types a turn id as missing-able on every turn event", () => {
    expectTypeOf<PluginLifecycleEvents["agent.turn_started"]["turnId"]>().toEqualTypeOf<string | null>();
    expectTypeOf<PluginLifecycleEvents["agent.turn_ended"]["turnId"]>().toEqualTypeOf<string | null>();
    type Turn = Extract<
      AgentStreamEvent,
      { type: "turn_started" | "turn_completed" | "turn_failed" | "turn_canceled" }
    >;
    expectTypeOf<Turn["turnId"]>().toEqualTypeOf<string | undefined>();

    const withoutId: AgentStreamEvent = { type: "turn_completed", provider: "claude" };
    expect(getAgentStreamEventTurnId(withoutId)).toBeUndefined();
    expect(getAgentStreamEventTurnId({ ...withoutId, turnId: "t1" })).toBe("t1");
  });

  it("types every usage field as optional, so a missing field is unknown, not zero", () => {
    const empty: AgentUsage = {};
    expect(empty.inputTokens).toBeUndefined();
    expectTypeOf<keyof AgentUsage>().toEqualTypeOf<
      | "inputTokens"
      | "cachedInputTokens"
      | "outputTokens"
      | "totalCostUsd"
      | "contextWindowMaxTokens"
      | "contextWindowUsedTokens"
    >();
    expectTypeOf<Required<AgentUsage>["inputTokens"]>().toEqualTypeOf<number>();
    expectTypeOf<Extract<AgentStreamEvent, { type: "usage_updated" }>["usage"]>().toEqualTypeOf<AgentUsage>();
    expectTypeOf<Extract<AgentStreamEvent, { type: "turn_completed" }>["usage"]>().toEqualTypeOf<
      AgentUsage | undefined
    >();
  });
});

describe("minimum host and build SDK", () => {
  const parseJson = <T extends z.ZodType>(schema: T, ...path: string[]) =>
    schema.parse(JSON.parse(readFileSync(join(root, ...path), "utf8")));
  const manifest = parseJson(
    z.object({ id: z.string(), requirements: z.object({ paseo: z.string() }) }),
    "paseo-plugin.json",
  );
  const installed = (name: string) =>
    parseJson(z.object({ version: z.string() }), "node_modules/@getpaseo", name, "package.json").version;
  const accepts = (version: string | null) =>
    assertPluginCompatibility({
      id: manifest.id,
      requirements: manifest.requirements,
      version,
      runtime: "daemon",
    });

  it("lets Paseo's own check accept 0.11.0 and newer, and refuse older or unknown hosts", () => {
    expect(() => accepts("0.11.0")).not.toThrow();
    expect(() => accepts("0.11.1")).not.toThrow();
    expect(() => accepts("0.10.9")).toThrow(/requires Paseo/);
    expect(() => accepts(null)).toThrow(/version is unknown/);
  });

  it("builds against one SDK version that the minimum host range includes", () => {
    expect(installed("client")).toBe(installed("plugin"));
    expect(() => accepts(installed("plugin"))).not.toThrow();
  });
});
