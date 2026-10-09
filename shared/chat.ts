import type { WireAttachment } from "./attachments";
import { BOT_LABEL, type Bot, type Library } from "./bot";
import { buildAgentConfig, defaultModelId, type PluginServers } from "./bot-agent";

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
      config: ReturnType<typeof buildAgentConfig>;
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
    snapshot(): Promise<{
      entries: { provider: string; models?: { id: string; isDefault?: boolean; isSelectable?: boolean }[] }[];
    }>;
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

async function ensureBotWorkspace(api: ChatApi, bot: Bot, placement: BotPlacement) {
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
  /** The chat's agent id, picked in advance so its tools URL can name it. */
  agentId?: string;
  plugin?: PluginServers;
  placement: BotPlacement;
  prompt: string;
  systemPrompt: string;
  /** Omitted: Paseo derives one from the prompt. */
  title?: string;
  labels?: Record<string, string>;
  images?: { data: string; mimeType: string }[];
  attachments?: WireAttachment[];
  clientMessageId?: string;
}

export async function startBotChat(api: ChatApi, input: StartChatInput): Promise<string> {
  const { bot } = input;
  const model = bot.model ?? (await resolveDefaultModel(api, bot.provider));
  const workspace = await ensureBotWorkspace(api, bot, input.placement);
  const agent = await workspace.agents.create({
    ...(input.agentId ? { agentId: input.agentId } : {}),
    config: buildAgentConfig(bot, {
      library: input.library,
      model,
      systemPrompt: input.systemPrompt,
      plugin: input.plugin,
    }),
    labels: { [BOT_LABEL]: bot.id, ...input.labels },
    prompt: input.prompt,
    ...(input.title ? { title: input.title.slice(0, MAX_TITLE_CHARS) } : {}),
    ...(input.images?.length ? { images: input.images } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
  });
  return agent.id;
}

async function resolveDefaultModel(api: ChatApi, provider: string): Promise<string> {
  const snapshot = await api.providers.snapshot();
  const entry = snapshot.entries.find((candidate) => candidate.provider === provider);
  const model = defaultModelId(entry?.models ?? []);
  if (!model) throw new Error(`${provider} has no models available. Pick a model in the bot's settings.`);
  return model;
}
