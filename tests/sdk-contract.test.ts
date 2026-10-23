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
import { BOT_LABEL, EMPTY_LIBRARY } from "../shared/bot";
import { type ChatApi, startBotChat } from "../shared/chat";
import { HostCapabilityError, toHostCapabilityError } from "../shared/host-capability";
import { connectFakeDaemon, type FakeDaemon, type Features } from "./fake-daemon";
import { makeBot } from "./helpers";

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

describe("startBotChat over the real SDK", () => {
  it("delivers the chosen agent id, labels, title, prompt and config to the daemon", async () => {
    daemon = await connectFakeDaemon(MODERN);
    const { api } = daemon;
    const handle = workspace(daemon);
    // Workspace lookups are stubbed; agents.create is the SDK's own.
    const chatApi: ChatApi = {
      projects: api.projects,
      providers: api.providers,
      workspaces: {
        list: async () => ({ entries: [] }),
        ref: api.workspaces.ref,
        open: api.workspaces.open,
        create: async () => handle,
      },
    };
    const bot = makeBot({ id: "bot-1", name: "Inbox", provider: "claude", model: "claude-sonnet-5-5" });

    const id = await startBotChat(chatApi, {
      bot,
      library: EMPTY_LIBRARY,
      agentId: "0b9f7c1e-4a2d-4f3b-9e6a-7c8d1e2f3a4b",
      placement: { path: "/work", projectRoot: null },
      prompt: "hello",
      systemPrompt: "be brief",
      title: "T".repeat(300),
      labels: { extra: "1" },
      clientMessageId: "cm-1",
    });

    expect(id).toBe("0b9f7c1e-4a2d-4f3b-9e6a-7c8d1e2f3a4b");
    const [request] = daemon.sent.filter((message) => message.type === "agent.create.request");
    expect(request).toMatchObject({
      agentId: "0b9f7c1e-4a2d-4f3b-9e6a-7c8d1e2f3a4b",
      initialPrompt: "hello",
      clientMessageId: "cm-1",
      labels: { [BOT_LABEL]: "bot-1", extra: "1" },
      config: { provider: "claude", model: "claude-sonnet-5-5", systemPrompt: "be brief" },
    });
    expect(request).toMatchObject({ config: { title: "T".repeat(200) } });
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
