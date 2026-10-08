import { useRpc } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppAccount, AppCard } from "../../shared/apps";
import { appsAccountsRpc, appsCatalogRpc, appsStatusRpc } from "../../shared/rpc";

// Apps state lives with Composio on this host, not in the bots settings, so it's read through the server.

export const APPS_KEY = ["paseo-bots", "apps"] as const;

export function useAppsStatus() {
  const status = useRpc(appsStatusRpc);
  return useQuery({ queryKey: [...APPS_KEY, "status"], queryFn: () => status({}), staleTime: 60_000 });
}

export function useAppsCatalog(enabled: boolean) {
  const catalog = useRpc(appsCatalogRpc);
  return useQuery({
    queryKey: [...APPS_KEY, "catalog"],
    queryFn: () => catalog({}),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function useAppsAccounts(enabled: boolean, polling = false) {
  const accounts = useRpc(appsAccountsRpc);
  return useQuery({
    queryKey: [...APPS_KEY, "accounts"],
    queryFn: () => accounts({ fresh: polling }),
    enabled,
    staleTime: 30_000,
    refetchInterval: polling ? 4_000 : false,
  });
}

export function useAppsInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: APPS_KEY });
}

/** Each app's status is the best of its accounts'. */
export function connectedApps(
  accounts: readonly AppAccount[],
  catalog: readonly AppCard[],
): (AppCard & { status: AppAccount["status"] })[] {
  const rank = { connected: 0, pending: 1, failed: 2 } as const;
  const bySlug = new Map<string, AppAccount["status"]>();
  for (const account of accounts) {
    const current = bySlug.get(account.slug);
    if (!current || rank[account.status] < rank[current]) bySlug.set(account.slug, account.status);
  }
  const cards = new Map(catalog.map((app) => [app.slug, app]));
  return [...bySlug]
    .map(([slug, status]) => ({
      ...(cards.get(slug) ?? {
        slug,
        name: slugName(slug),
        description: "",
        logo: null,
        domain: null,
        noAuth: false,
      }),
      status,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function slugName(slug: string): string {
  return slug
    .split(/[_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
