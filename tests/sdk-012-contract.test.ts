import type { PaseoAgentRunResult } from "@getpaseo/client";
import type { PaseoWorkspaceAgentCreateOptions, PaseoAgentRunResult as Run012 } from "@getpaseo/client-012";
import { type AgentStreamEvent, getAgentStreamEventTurnId } from "@getpaseo/protocol-012/agent-types";
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { HostCapabilityError, toHostCapabilityError } from "../shared/host-capability";
import { connectFakeDaemon, type FakeDaemon } from "./fake-daemon";

const MODERN = { creationLifecycle: true, agentRequestReceipts: true };
const CREATE = {
  agentId: "00112233-4455-4677-8899-aabbccddeeff",
  idempotencyKey: "sdk-012-create",
  config: { provider: "omp/openai-codex/gpt-6.1-sol" },
  prompt: "Synthetic compatibility request",
  env: { FIXTURE_VALUE: "forwarded" },
  clientMessageId: "sdk-012-message",
  outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
} satisfies PaseoWorkspaceAgentCreateOptions;
let daemon: FakeDaemon | null = null;
afterEach(async () => {
  await daemon?.close();
  daemon = null;
});

describe("SDK0.12.0 create compatibility", () => {
  it("preserves managed identity and create fields, leaving absent host usage unknown", async () => {
    daemon = await connectFakeDaemon(MODERN, "0.12.0");
    const workspace = daemon.api.workspaces.ref({ id: "ws-1", workspaceDirectory: "/work" } as never);
    const agent = await workspace.agents.create(CREATE);
    expect(agent.id).toBe(CREATE.agentId);
    expect(agent.lastUsage).toBeNull();
    expect(daemon.sent.filter(({ type }) => type === "agent.create.request")).toEqual([
      expect.objectContaining({
        agentId: CREATE.agentId,
        idempotencyKey: CREATE.idempotencyKey,
        env: CREATE.env,
        clientMessageId: CREATE.clientMessageId,
        outputSchema: CREATE.outputSchema,
        initialPrompt: CREATE.prompt,
      }),
    ]);
  });

  it("shares a pending identical request but rejects the same key with a changed body", async () => {
    daemon = await connectFakeDaemon(MODERN, "0.12.0");
    const workspace = daemon.api.workspaces.ref({ id: "ws-1", workspaceDirectory: "/work" } as never);
    daemon.hold();
    const first = workspace.agents.create(CREATE);
    const second = workspace.agents.create(CREATE);
    await expect(workspace.agents.create({ ...CREATE, prompt: "Different task" })).rejects.toThrow(
      "agent_request_key_conflict",
    );
    daemon.release();
    expect((await first).id).toBe(CREATE.agentId);
    expect((await second).id).toBe(CREATE.agentId);
    expect(daemon.sent.filter(({ type }) => type === "agent.create.request")).toHaveLength(1);
  });
});

describe("SDK0.12.0 unsupported-host and lifecycle boundaries", () => {
  it("refuses caller-selected identity before sending any legacy create request", async () => {
    daemon = await connectFakeDaemon({}, "0.12.0");
    const workspace = daemon.api.workspaces.ref({ id: "ws-1", workspaceDirectory: "/work" } as never);
    let error: unknown;
    try {
      await workspace.agents.create(CREATE);
    } catch (caught) {
      error = caught;
    }
    expect(toHostCapabilityError(error)).toBeInstanceOf(HostCapabilityError);
    expect(daemon.sent).toEqual([]);
  });

  it("retains nullable host turn evidence and the execution-result vocabulary", () => {
    expectTypeOf<Run012["status"]>().toEqualTypeOf<PaseoAgentRunResult["status"]>();
    const event: AgentStreamEvent = { type: "turn_completed", provider: "omp" };
    expect(getAgentStreamEventTurnId(event)).toBeUndefined();
    expect(getAgentStreamEventTurnId({ ...event, turnId: "reused-host-id" })).toBe("reused-host-id");
  });
});
