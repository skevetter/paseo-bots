import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPaseoApi as createPaseoApi012 } from "@getpaseo/client-012";
import { DaemonClient as DaemonClient012 } from "@getpaseo/client-012/internal/daemon-client";

// Drives the installed SDK's real DaemonClient over an in-memory transport, so fixtures observe what
// the SDK puts on the wire and which errors it throws, with no network.

export type Features = Record<string, boolean>;

export interface FakeDaemon {
  api: PaseoApi;
  /** Every JSON frame the client sent after the hello, unwrapped from its session envelope. */
  sent: Record<string, unknown>[];
  /** Hold create replies until `release`, so a test can overlap in-flight requests. */
  hold(): void;
  release(): void;
  close(): Promise<void>;
}

export const NOW = "2026-10-23T00:00:00.000Z";

export function agentSnapshot(id: string, patch: Record<string, unknown> = {}) {
  return {
    id,
    provider: "claude",
    cwd: "/work",
    workspaceId: "ws-1",
    model: "claude-sonnet-5-5",
    createdAt: NOW,
    updatedAt: NOW,
    lastUserMessageAt: null,
    status: "idle",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: true,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    labels: {},
    ...patch,
  };
}

/**
 * `features` is the server_info feature map the daemon advertises. A host without
 * `creationLifecycle` takes the SDK's legacy `create_agent_request` path instead.
 */
export async function connectFakeDaemon(
  features: Features,
  version: "0.11.1" | "0.12.0" = "0.11.1",
): Promise<FakeDaemon> {
  const sent: Record<string, unknown>[] = [];
  let held: (() => void)[] | null = null;
  let deliver: (data: unknown, isBinary: boolean) => void = () => {};
  const reply = (message: unknown) => deliver(JSON.stringify({ type: "session", message }), false);

  const respond = (message: Record<string, unknown>) => {
    const requestId = message.requestId as string;
    const agentId = (message.agentId as string | undefined) ?? "daemon-picked-id";
    if (message.type === "agent.create.request") {
      reply({
        type: "agent.create.response",
        payload: { requestId, agent: agentSnapshot(agentId), error: null },
      });
    } else if (message.type === "create_agent_request") {
      reply({
        type: "status",
        payload: { status: "agent_created", requestId, agentId, agent: agentSnapshot(agentId) },
      });
    }
  };

  const transport = {
    send(data: string | ArrayBuffer | Uint8Array) {
      const frame = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data)) as Record<
        string,
        unknown
      >;
      if (frame.type === "hello") {
        queueMicrotask(() =>
          reply({
            type: "status",
            payload: { status: "server_info", serverId: "fake", version, features },
          }),
        );
        return;
      }
      const message = (frame.message ?? frame) as Record<string, unknown>;
      sent.push(message);
      if (held) held.push(() => respond(message));
      else queueMicrotask(() => respond(message));
    },
    close() {},
    onMessage(handler: typeof deliver) {
      deliver = handler;
      return () => {};
    },
    onOpen(handler: () => void) {
      queueMicrotask(handler);
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };

  const Client = version === "0.12.0" ? DaemonClient012 : DaemonClient;
  const client = new Client({
    url: "ws://fake.invalid",
    clientId: "paseo-bots-fixture",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  await client.connect();
  return {
    api: client instanceof DaemonClient012 ? createPaseoApi012(client) : createPaseoApi(client),
    sent,
    hold() {
      held = [];
    },
    release() {
      const queued = held ?? [];
      held = null;
      for (const run of queued) run();
    },
    close: () => client.close(),
  };
}
