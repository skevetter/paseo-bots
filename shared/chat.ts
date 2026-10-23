import { z } from "zod";
import type { WireAttachment } from "./attachments";
import { BOT_LABEL, type Bot, type Library } from "./bot";
import { type BotAgentConfig, buildAgentConfig, defaultModelId, type PluginServers } from "./bot-agent";
import { type ProviderEntry, providerInfo } from "./changes/context";
import { toHostCapabilityError } from "./host-capability";
import type { MemoryBudgetStats } from "./memory-budget";
import {
  launchSettings,
  type PolicyState,
  type Resolution,
  resolveBot,
  snapshotCapabilities,
  usesPolicy,
} from "./policies";
import { PURPOSE_LABEL, type Purpose } from "./runs";
import { newUuid } from "./uuid";

/** Carries the routine id. */
export const ROUTINE_LABEL = "paseo-bots.routine";
/** Paseo's limit (protocol/agent-title-limits.ts). */
const MAX_TITLE_CHARS = 200;

/** Starts the setup interview from a bot's panel. */
export const SETUP_PROMPT =
  "Let's set you up. Interview me one short question at a time about what I want from you, how I like to work, and what you should never do. " +
  "Then propose standing instructions for yourself and a starting MEMORY.md. Write the memory file once I confirm, and give me the instructions to paste into your Soul settings.";

/** Older chats were titled "[Bot Name] …"; views grouped by bot drop the prefix. */
export function displayTitle(title: string | null | undefined): string {
  return (title ?? "").replace(/^\[[^\]]*\]\s*/, "") || "New chat";
}

export interface BotPlacement {
  path: string;
  /** Null when the bot has its own working folder. */
  projectRoot: string | null;
}

const normalize = (path: string | null | undefined) => (path ?? "").replace(/\/+$/, "");

// Shared code may only import the plugin SDK's root, so callers pass their Paseo API in, checked against this.

interface ChatWorkspace {
  projectId: string;
  projectRootPath: string;
  workspaceDirectory?: string;
  title?: string | null;
}

interface WorkspaceHandle {
  current(): ChatWorkspace | null;
  refresh(): Promise<ChatWorkspace | null>;
  setTitle(title: string): Promise<unknown>;
  archive(): Promise<unknown>;
  readonly agents: {
    create(options: {
      agentId?: string;
      idempotencyKey?: string;
      env?: Record<string, string>;
      outputSchema?: Record<string, unknown>;
      onEvent?: CreationObserver;
      config: BotAgentConfig;
      labels: Record<string, string>;
      prompt: string;
      title?: string;
      images?: { data: string; mimeType: string }[];
      attachments?: WireAttachment[];
      clientMessageId?: string;
    }): Promise<{ readonly id: string }>;
  };
}

export interface ChatApi {
  readonly projects: { list(): Promise<{ projects: ChatWorkspace[] }> };
  readonly workspaces: {
    list(): Promise<{ entries: ChatWorkspace[] }>;
    ref(workspace: string | ChatWorkspace): WorkspaceHandle;
    open(path: string): Promise<WorkspaceHandle>;
    create(options: {
      title: string;
      source: { kind: "directory"; path: string; projectId?: string };
    }): Promise<WorkspaceHandle>;
  };
  readonly providers: {
    snapshot(): Promise<{ entries: ProviderEntry[] }>;
  };
}

/**
 * Opening a folder registers the Paseo project but also creates a workspace for
 * the folder itself; that one is archived so the project only lists bot workspaces.
 */
async function botsProjectId(api: ChatApi, root: string): Promise<string> {
  const { projects } = await api.projects.list();
  const existing = projects.find((project) => normalize(project.projectRootPath) === normalize(root));
  if (existing) return existing.projectId;
  const rootWorkspace = await api.workspaces.open(root);
  const snapshot = rootWorkspace.current() ?? (await rootWorkspace.refresh());
  if (!snapshot) throw new Error("Paseo didn't register the Bots project.");
  await rootWorkspace.archive().catch(() => undefined);
  return snapshot.projectId;
}

async function ensureBotWorkspace(api: ChatApi, bot: Pick<Bot, "name">, placement: BotPlacement) {
  const { entries } = await api.workspaces.list();
  const mine = entries.find(
    (workspace) =>
      normalize(workspace.workspaceDirectory ?? workspace.projectRootPath) === normalize(placement.path) &&
      // A custom folder can have other workspaces; only the one named after the bot is the bot's.
      (placement.projectRoot !== null || workspace.title === bot.name),
  );
  if (mine) {
    const handle = api.workspaces.ref(mine);
    if (mine.title !== bot.name) await handle.setTitle(bot.name);
    return handle;
  }
  const projectId = placement.projectRoot ? await botsProjectId(api, placement.projectRoot) : undefined;
  return api.workspaces.create({
    title: bot.name,
    source: { kind: "directory", path: placement.path, ...(projectId ? { projectId } : {}) },
  });
}

export async function syncBotWorkspaceTitle(api: ChatApi, bot: Bot, placement: BotPlacement): Promise<void> {
  if (placement.projectRoot === null) return;
  const { entries } = await api.workspaces.list();
  const mine = entries.find(
    (workspace) =>
      normalize(workspace.workspaceDirectory ?? workspace.projectRootPath) === normalize(placement.path),
  );
  if (mine && mine.title !== bot.name) await api.workspaces.ref(mine).setTitle(bot.name);
}

export interface StartChatInput {
  bot: Bot;
  library: Library;
  /** What the bot's provider, model, mode and thinking level resolve from; every path that starts a chat passes it. */
  policy: PolicyState;
  /** The routine this chat runs, whose overrides apply. */
  routineId?: string;
  /** The chat's agent id, picked in advance so its tools URL can name it. */
  agentId?: string;
  idempotencyKey?: string;
  env?: Record<string, string>;
  outputSchema?: Record<string, unknown>;
  onEvent?: CreationObserver;
  context?: PreparedContext;
  plugin?: PluginServers;
  placement: BotPlacement;
  prompt: string;
  systemPrompt: string;
  /** Omitted: Paseo derives one from the prompt. */
  title?: string;
  labels?: Record<string, string>;
  /** Why the chat exists; a chat that isn't a task stays out of review windows. Defaults to a task. */
  purpose?: Purpose;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  clientMessageId?: string;
}

/** Host evidence only. Nullable IDs and repeated events are not deduplication keys. */
export interface CreationEvidence {
  kind: "workspace" | "agent";
  idempotencyKey: string;
  revision: number;
  phase: "accepted" | "workspace_ready" | "agent_ready" | "prompt_started" | "completed" | "failed";
  workspaceId: string | null;
  agentId: string | null;
  error: string | null;
  errorCode?: string;
  failedStage?: "workspace" | "agent" | "prompt";
  outcomeUnknown?: boolean;
  setupSkippedReason?: string;
  agent?: unknown;
  workspace?: unknown;
}

export type CreationObserver = (evidence: CreationEvidence) => void;

export interface MemoryContextReceipt {
  backend: "files";
  /** SHA-256 of the exact trimmed memory text rendered into the prompt. */
  contentHash: string;
  stats: MemoryBudgetStats;
}

export interface PreparedContext {
  systemPromptHash: string | null;
  userPromptHash: string | null;
  memoryContextReceipt: MemoryContextReceipt | null;
  playbooks: { id: string; version?: string; contentHash: string }[];
  inputArtifactRefs: string[];
  environmentVersion: string | null;
}

export interface PermissionEnvelope {
  modeId: string | null;
  alwaysAllow: string[];
  contactBots: Bot["contactBots"];
  mcpServerNames: string[];
  toolPolicy?: BotAgentConfig["toolPolicy"];
  apps: string[];
  appRules: Bot["appRules"];
}

/** Safe run metadata: no config, prompts, relay URLs, headers or environment values. */
export interface PreparedChatMetadata extends PreparedContext {
  resolvedPolicy: Resolution;
  permissionEnvelope: PermissionEnvelope;
}

/** Restricted relay authorization captured at admission, including resolved read-only tool lists. */
export interface FrozenRelayPermissions {
  contactBots: Bot["contactBots"];
  apps: string[];
  appLimits: Record<
    string,
    {
      tools: string[] | null;
      account: { id: string; alias: string | null } | null;
    }
  >;
}

/** Restricted execution artifact. Never return this through a public RPC or write it to logs. */
export interface PreparedBotChat {
  version: 1;
  agentId: string;
  idempotencyKey: string;
  botId: string;
  botName: string;
  hostId: string | null;
  purpose: Purpose;
  provider: string;
  model: string;
  placement: BotPlacement;
  config: BotAgentConfig;
  prompt: string;
  labels: Record<string, string>;
  title?: string;
  env?: Record<string, string>;
  clientMessageId?: string;
  outputSchema?: Record<string, unknown>;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  metadata: PreparedChatMetadata;
  relay?: { tools: boolean; apps: boolean; permissions: FrozenRelayPermissions };
}

async function resolveChatExecution(api: ChatApi, input: StartChatInput) {
  const entries = (await api.providers.snapshot()).entries;
  const providers =
    input.bot.model === null || usesPolicy(input.policy, input.bot, input.routineId)
      ? providerInfo(entries)
      : null;
  const resolvedPolicy = resolveBot(input.policy, input.bot, {
    routineId: input.routineId,
    providers,
    capabilities: providers ? snapshotCapabilities(providers, null) : undefined,
  });
  const launch = launchSettings(resolvedPolicy);
  const model = launch.model ?? defaultModel(entries, launch.provider);
  const entry = entries.find((candidate) => candidate.provider === launch.provider);
  const modeId = launch.modeId ?? entry?.defaultModeId ?? null;
  const thinkingOptionId =
    launch.thinkingOptionId ??
    entry?.models?.find((candidate) => candidate.id === model)?.defaultThinkingOptionId ??
    null;
  const bot = {
    ...input.bot,
    provider: launch.provider,
    modeId,
    thinkingOptionId,
  };
  return { resolvedPolicy, model, bot };
}

/** Resolves once, without registering a project, workspace or agent. */
export async function prepareBotChat(api: ChatApi, input: StartChatInput): Promise<PreparedBotChat> {
  const agentId = z.uuid().parse(input.agentId ?? newUuid());
  const { resolvedPolicy, model, bot } = await resolveChatExecution(api, input);
  const config = buildAgentConfig(bot, {
    library: input.library,
    model,
    systemPrompt: input.systemPrompt,
    plugin: input.plugin,
  });
  const purpose = input.purpose ?? "task";
  // Detach every nested value from editable bot/library/input state, including MCP credentials.
  return JSON.parse(
    JSON.stringify({
      version: 1,
      agentId,
      idempotencyKey: input.idempotencyKey ?? `paseo-bots:${agentId}`,
      botId: bot.id,
      botName: bot.name,
      hostId: bot.hostId,
      purpose,
      provider: bot.provider,
      model,
      placement: input.placement,
      config,
      labels: { ...input.labels, [BOT_LABEL]: bot.id, [PURPOSE_LABEL]: purpose },
      prompt: input.prompt,
      title: input.title ? input.title.slice(0, MAX_TITLE_CHARS) : undefined,
      images: input.images?.length ? input.images : undefined,
      attachments: input.attachments?.length ? input.attachments : undefined,
      clientMessageId: input.clientMessageId,
      env: input.env,
      outputSchema: input.outputSchema,
      metadata: {
        systemPromptHash: null,
        userPromptHash: null,
        memoryContextReceipt: null,
        playbooks: [],
        inputArtifactRefs: [],
        environmentVersion: null,
        ...input.context,
        resolvedPolicy,
        permissionEnvelope: {
          modeId: bot.modeId,
          alwaysAllow: bot.alwaysAllow,
          contactBots: bot.contactBots,
          mcpServerNames: Object.keys(config.mcpServers ?? {}),
          toolPolicy: config.toolPolicy,
          apps: bot.apps,
          appRules: bot.appRules,
        },
      },
    }),
  ) as PreparedBotChat;
}

/** Replays only the frozen artifact. An observer is execution-time evidence, never persisted config. */
export async function launchPreparedBotChat(
  api: ChatApi,
  prepared: PreparedBotChat,
  observer?: CreationObserver,
): Promise<string> {
  z.uuid().parse(prepared.agentId);
  try {
    const workspace = await ensureBotWorkspace(api, { name: prepared.botName }, prepared.placement);
    const agent = await workspace.agents.create({
      agentId: prepared.agentId,
      idempotencyKey: prepared.idempotencyKey,
      config: prepared.config,
      labels: prepared.labels,
      prompt: prepared.prompt,
      ...(prepared.title !== undefined ? { title: prepared.title } : {}),
      ...(prepared.images !== undefined ? { images: prepared.images } : {}),
      ...(prepared.attachments !== undefined ? { attachments: prepared.attachments } : {}),
      ...(prepared.clientMessageId !== undefined ? { clientMessageId: prepared.clientMessageId } : {}),
      ...(prepared.env !== undefined ? { env: prepared.env } : {}),
      ...(prepared.outputSchema !== undefined ? { outputSchema: prepared.outputSchema } : {}),
      ...(observer ? { onEvent: observer } : {}),
    });
    return agent.id;
  } catch (error) {
    throw toHostCapabilityError(error) ?? error;
  }
}

export async function startBotChat(api: ChatApi, input: StartChatInput): Promise<string> {
  return launchPreparedBotChat(api, await prepareBotChat(api, input), input.onEvent);
}

function defaultModel(entries: readonly ProviderEntry[] | null, provider: string): string {
  const entry = entries?.find((candidate) => candidate.provider === provider);
  const model = defaultModelId(entry?.models ?? []);
  if (!model) throw new Error(`${provider} has no models available. Pick a model in the bot's settings.`);
  return model;
}
