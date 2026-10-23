import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderEntry } from "../shared/changes/context";
import type { CreationEvidence } from "../shared/chat";

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
  setProviders(entries: ProviderEntry[]): void;
  creation(events: Omit<CreationEvidence, "idempotencyKey">[], error?: string): void;
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

class DaemonReplies {
  providers: ProviderEntry[] = [
    {
      provider: "claude",
      enabled: true,
      status: "ready",
      models: [{ id: "claude-sonnet-5-5", label: "Sonnet", isDefault: true }],
      modes: [{ id: "default", label: "Ask" }],
      defaultModeId: "default",
    },
  ];
  creationEvents: Omit<CreationEvidence, "idempotencyKey">[] = [];
  creationError: string | null = null;

  constructor(private readonly reply: (message: unknown) => void) {}

  respond(message: Record<string, unknown>): void {
    const requestId = message.requestId as string;
    switch (message.type) {
      case "get_daemon_config_request":
        this.reply({
          type: "get_daemon_config_response",
          payload: { requestId, config: { mcp: { injectIntoAgents: true } } },
        });
        break;
      case "get_providers_snapshot_request":
        this.providerSnapshot(requestId);
        break;
      case "fetch_workspaces_request":
        this.reply({
          type: "fetch_workspaces_response",
          payload: {
            requestId,
            entries: [FIXTURE_WORKSPACE],
            pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
          },
        });
        break;
      case "agent.create.request":
        this.agentCreate(message);
        break;
      case "create_agent_request": {
        const agentId = (message.agentId as string | undefined) ?? "daemon-picked-id";
        this.reply({
          type: "status",
          payload: { status: "agent_created", requestId, agentId, agent: agentSnapshot(agentId) },
        });
        break;
      }
    }
  }

  private providerSnapshot(requestId: string): void {
    this.reply({
      type: "get_providers_snapshot_response",
      payload: {
        requestId,
        generatedAt: NOW,
        entries: this.providers.map((entry) => ({
          ...entry,
          models: entry.models?.map((model) => ({
            ...model,
            provider: entry.provider,
            thinkingOptions: model.thinkingOptions?.map((option) => ({ ...option, label: option.id })),
          })),
        })),
      },
    });
  }

  private agentCreate(message: Record<string, unknown>): void {
    const agentId = (message.agentId as string | undefined) ?? "daemon-picked-id";
    const snapshots = this.creationEvents.map((event) => ({
      ...event,
      idempotencyKey: message.idempotencyKey,
    }));
    for (const snapshot of snapshots) this.reply({ type: "agent.create.update", payload: snapshot });
    this.reply({
      type: "agent.create.response",
      payload: {
        requestId: message.requestId,
        agent: this.creationError ? null : agentSnapshot(agentId),
        error: this.creationError,
        creation: snapshots.at(-1),
      },
    });
  }
}

const FIXTURE_WORKSPACE = {
  id: "ws-1",
  projectId: "project-1",
  projectDisplayName: "Work",
  projectRootPath: "/work",
  workspaceDirectory: "/work",
  projectKind: "directory",
  workspaceKind: "directory",
  name: "Inbox",
  title: "Inbox",
  status: "done",
  activityAt: null,
  gitRuntime: null,
  githubRuntime: null,
};

/**
 * `features` is the server_info feature map the daemon advertises. A host without
 * `creationLifecycle` takes the SDK's legacy `create_agent_request` path instead.
 */
export async function connectFakeDaemon(features: Features): Promise<FakeDaemon> {
  const sent: Record<string, unknown>[] = [];
  let held: (() => void)[] | null = null;
  let deliver: (data: unknown, isBinary: boolean) => void = () => {};
  const reply = (message: unknown) => deliver(JSON.stringify({ type: "session", message }), false);

  const server = new DaemonReplies(reply);

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
            payload: {
              status: "server_info",
              serverId: "fake",
              version: "0.11.1",
              features: { workspaceMultiplicity: true, ...features },
            },
          }),
        );
        return;
      }
      const message = (frame.message ?? frame) as Record<string, unknown>;
      sent.push(message);
      if (held && (message.type === "agent.create.request" || message.type === "create_agent_request"))
        held.push(() => server.respond(message));
      else queueMicrotask(() => server.respond(message));
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

  const client = new DaemonClient({
    url: "ws://fake.invalid",
    clientId: "paseo-bots-fixture",
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });
  await client.connect();
  return {
    api: createPaseoApi(client),
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
    setProviders(entries) {
      server.providers = entries;
    },
    creation(events, error) {
      server.creationEvents = events;
      server.creationError = error ?? null;
    },
  };
}
