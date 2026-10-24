import { createPaseoApi, type PaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ProviderEntry } from "../shared/changes/context";
import type { CreationEvidence } from "../shared/chat";

// Drives the installed SDK's real DaemonClient over an in-memory transport, so fixtures observe what
// the SDK puts on the wire and which errors it throws, with no network.

export type Features = Record<string, boolean>;

type HeldRequest = "create" | "workspaces" | "agents";
const HELD_FRAMES: Record<HeldRequest, readonly unknown[]> = {
  create: ["agent.create.request", "create_agent_request"],
  workspaces: ["fetch_workspaces_request"],
  agents: ["fetch_agent_request"],
};

export interface FakeDaemon {
  api: PaseoApi;
  /** Every JSON frame the client sent after the hello, unwrapped from its session envelope. */
  sent: Record<string, unknown>[];
  /** Hold selected replies until `release`, so a test can interrupt asynchronous setup or creation. */
  hold(request?: HeldRequest): void;
  release(): void;
  setProviders(entries: ProviderEntry[]): void;
  creation(events: Omit<CreationEvidence, "idempotencyKey">[], error?: string): void;
  beforeSessionOpen(handler: (request: PluginSessionOpenRequest) => Promise<void>): void;
  setAgent(agentId: string, patch: Record<string, unknown> | null): void;
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

const SessionCreationSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string(),
  config: z.object({ provider: z.string() }),
  env: z.record(z.string(), z.string()).default({}),
});

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
  sessionOpening?: (request: PluginSessionOpenRequest) => Promise<void>;
  readonly agents = new Map<string, Record<string, unknown>>();

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
      case "fetch_agent_request":
        this.reply({
          type: "fetch_agent_response",
          payload: {
            requestId,
            agent: this.agents.get(message.agentId as string) ?? null,
            project: null,
            error: null,
          },
        });
        break;
      case "agent.create.request":
        void this.agentCreate(message);
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

  private async agentCreate(message: Record<string, unknown>): Promise<void> {
    const error = this.sessionOpening
      ? ((await this.openSession(message)) ?? this.creationError)
      : this.creationError;
    const agentId = (message.agentId as string | undefined) ?? "daemon-picked-id";
    const agent = agentSnapshot(agentId, { labels: message.labels ?? {} });
    if (!error) this.agents.set(agentId, agent);
    const snapshots = this.creationEvents.map((event) => ({
      ...event,
      idempotencyKey: message.idempotencyKey,
    }));
    for (const snapshot of snapshots) this.reply({ type: "agent.create.update", payload: snapshot });
    this.reply({
      type: "agent.create.response",
      payload: {
        requestId: message.requestId,
        agent: error ? null : agent,
        error,
        creation: snapshots.at(-1),
      },
    });
  }

  private async openSession(message: Record<string, unknown>): Promise<string | null> {
    if (!this.sessionOpening) return null;
    try {
      const input = SessionCreationSchema.parse(message);
      await this.sessionOpening({
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        provider: input.config.provider,
        cwd: FIXTURE_WORKSPACE.workspaceDirectory,
        reason: "create",
        purpose: "interactive",
        env: input.env,
      });
      return null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
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
  let heldRequest: HeldRequest = "create";
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
      if (held && HELD_FRAMES[heldRequest].includes(message.type)) held.push(() => server.respond(message));
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
    hold(request = "create") {
      held = [];
      heldRequest = request;
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
    beforeSessionOpen(handler) {
      server.sessionOpening = handler;
    },
    setAgent(agentId, patch) {
      if (patch === null) server.agents.delete(agentId);
      else server.agents.set(agentId, agentSnapshot(agentId, patch));
    },
  };
}
