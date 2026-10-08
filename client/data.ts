import { getPaseoClient, type PluginHostSummary, useHosts, usePaseo } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { BOT_LABEL } from "../shared/bot";
import { type PaseoToolsConfig, paseoToolsState } from "../shared/paseo-tools";
import type { PaseoAgent, PaseoApi } from "./paseo";

export interface LocalHost {
  id: string;
  label: string;
}

export interface BotHost {
  api: PaseoApi | null;
  /** Stable key for queries; the local host uses its own id. */
  key: string;
  label: string;
  isLocal: boolean;
  online: boolean;
}

type HostSummaries = readonly PluginHostSummary[];
type HostStatus = PluginHostSummary["status"];

function localBotHost(local: LocalHost, localApi: PaseoApi): BotHost {
  return { api: localApi, key: local.id, label: local.label, isLocal: true, online: true };
}

function remoteBotHost(
  hostId: string,
  summaryLabel: string | undefined,
  status: HostStatus | undefined,
): BotHost {
  const label = summaryLabel ?? "Unknown host";
  if (status !== "online") return { api: null, key: hostId, label, isLocal: false, online: false };
  try {
    return { api: getPaseoClient(hostId), key: hostId, label, isLocal: false, online: true };
  } catch {
    return { api: null, key: hostId, label, isLocal: false, online: false };
  }
}

function resolveHost(
  hostId: string | null,
  local: LocalHost,
  localApi: PaseoApi,
  hosts: HostSummaries,
): BotHost {
  if (!hostId || hostId === local.id) return localBotHost(local, localApi);
  const summary = hosts.find((host) => host.serverId === hostId);
  return remoteBotHost(hostId, summary?.label, summary?.status);
}

function requireApi(host: BotHost): PaseoApi {
  if (!host.api) throw new Error(`${host.label} is offline`);
  return host.api;
}

/** Resolves the host a bot runs on. `hostId === null` is the host that stores the bots. */
export function useBotHost(hostId: string | null, local: LocalHost): BotHost {
  const localApi = usePaseo();
  const hosts = useHosts();
  const { id: localId, label: localLabel } = local;
  const summary = hostId ? hosts.find((host) => host.serverId === hostId) : undefined;
  const summaryLabel = summary?.label;
  const status = summary?.status;
  return useMemo(
    () =>
      !hostId || hostId === localId
        ? localBotHost({ id: localId, label: localLabel }, localApi)
        : remoteBotHost(hostId, summaryLabel, status),
    // Only the fields that change the result.
    [hostId, localId, localLabel, localApi, summaryLabel, status],
  );
}

/** The same resolution outside render, e.g. for menu actions. */
export function useHostResolver(local: LocalHost): (hostId: string | null) => BotHost {
  const localApi = usePaseo();
  const hosts = useHosts();
  return (hostId) => resolveHost(hostId, local, localApi, hosts);
}

export function useProviders(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "providers", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => {
      const snapshot = await requireApi(host).providers.snapshot();
      return snapshot.entries.filter((entry) => entry.enabled);
    },
  });
}

export function useAgentProfiles(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "profiles", host.key],
    enabled: !!host.api,
    staleTime: 60_000,
    queryFn: async () => (await requireApi(host).config.get()).config.agentProfiles ?? [],
  });
}

export function useHostWorkspaces(host: BotHost) {
  return useQuery({
    queryKey: ["paseo-bots", "workspaces", host.key],
    enabled: !!host.api,
    staleTime: 30_000,
    queryFn: async () => {
      const result = await requireApi(host).workspaces.list();
      return result.entries.map((workspace) => ({
        id: workspace.id,
        label: workspace.title || `${workspace.projectDisplayName} · ${workspace.name}`,
        directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
      }));
    },
  });
}

export function useBotChats(host: BotHost, botId: string) {
  return useQuery({
    queryKey: ["paseo-bots", "chats", host.key, botId],
    enabled: !!host.api,
    // The local host pushes agent updates (useChatInvalidation); other hosts are polled.
    refetchInterval: host.isLocal ? false : 15_000,
    queryFn: async (): Promise<PaseoAgent[]> => {
      const result = await requireApi(host).agents.list({ filter: { labels: { [BOT_LABEL]: botId } } });
      return result.entries
        .map((entry) => entry.agent)
        .filter((agent) => !agent.archivedAt)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
  });
}

/** Refetches chat lists shortly after any agent update, so chats routines start show up too. */
export function useChatInvalidation() {
  const paseo = usePaseo();
  const queryClient = useQueryClient();
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let subscription: { release(): Promise<void> } | null = null;
    const unsubscribe = paseo.agents.subscribe(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: ["paseo-bots", "chats"] });
      }, 500);
    });
    // The daemon only sends agent updates to sessions that subscribed through a list request.
    void paseo.agents
      .list({ page: { limit: 1 }, subscribe: {} })
      .then((result) => {
        if (closed) void result.subscription.release();
        else subscription = result.subscription;
      })
      .catch(() => {});
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
      void subscription?.release();
    };
  }, [paseo, queryClient]);
}

/** The host's Paseo-tools settings for a provider, and a way to turn them on. */
export function usePaseoTools(host: BotHost, provider: string) {
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "paseo-tools", host.key];
  const config = useQuery({
    queryKey: key,
    enabled: !!host.api,
    staleTime: 30_000,
    queryFn: async () => (await requireApi(host).config.get()).config as PaseoToolsConfig,
  });
  const state = config.data ? paseoToolsState(config.data, provider) : null;
  const turnOn = async () => {
    if (!host.api || !state || state.on) return;
    await host.api.config.patch(
      state.reason === "provider"
        ? { providers: { [provider]: { paseoTools: { enabled: true } } } }
        : { mcp: { injectIntoAgents: true } },
    );
    await queryClient.invalidateQueries({ queryKey: key });
  };
  return { state, loading: config.isLoading, turnOn };
}
