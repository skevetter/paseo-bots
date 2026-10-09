import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import type { AppAccount, AppCard } from "../../shared/apps";
import { appsConnectRpc } from "../../shared/rpc";
import { errorText } from "../native";
import type { SetTarget } from "./actions";
import { useAppsAccounts, useAppsCatalog, useAppsInvalidate, useAppsStatus } from "./apps";

interface PendingSignIn {
  slug: string;
  since: number;
  known: string[];
}

export interface AppConnections {
  /** App whose sign-in is open in the browser. */
  pending: string | null;
  accounts: AppAccount[];
  catalog: AppCard[];
  startConnect(slug: string, alias?: string): Promise<void>;
}

export function useAppConnections(setTarget: SetTarget): AppConnections {
  const toast = useToast();
  const connectApp = useRpc(appsConnectRpc);
  const invalidateApps = useAppsInvalidate();
  const [pending, setPending] = useState<PendingSignIn | null>(null);
  const appsStatus = useAppsStatus();
  const appsConfigured = appsStatus.data?.configured ?? false;
  const appAccounts = useAppsAccounts(appsConfigured, pending !== null);
  const appCatalog = useAppsCatalog(appsConfigured);
  const accountsData = appAccounts.data;
  const latestRef = useRef({ catalog: appCatalog.data?.apps, toast, setTarget, invalidateApps });
  latestRef.current = { catalog: appCatalog.data?.apps, toast, setTarget, invalidateApps };

  useEffect(() => {
    if (!pending) return;
    if (hasNewAccount(accountsData?.accounts ?? [], pending)) {
      const latest = latestRef.current;
      const name = latest.catalog?.find((app) => app.slug === pending.slug)?.name ?? pending.slug;
      latest.toast.show(`Connected ${name}`, { variant: "success" });
      setPending(null);
      latest.setTarget({ kind: "app", id: pending.slug });
      void latest.invalidateApps();
    } else if (Date.now() - pending.since > 5 * 60_000) {
      setPending(null);
    }
  }, [accountsData, pending]);

  /** The accounts query polls until the sign-in finishes. */
  const startConnect = async (slug: string, alias?: string) => {
    try {
      const { url } = await connectApp({ slug, ...(alias?.trim() ? { alias: alias.trim() } : {}) });
      setPending({
        slug,
        since: Date.now(),
        known: (appAccounts.data?.accounts ?? [])
          .filter((entry) => entry.slug === slug)
          .map((entry) => entry.id),
      });
      await openExternalUrl(url);
    } catch (error) {
      setPending(null);
      toast.error(`Couldn't start the sign-in: ${errorText(error)}`);
    }
  };

  return {
    pending: pending?.slug ?? null,
    accounts: appAccounts.data?.accounts ?? [],
    catalog: appCatalog.data?.apps ?? [],
    startConnect,
  };
}

/** The app may already have accounts; only a new one finishes the sign-in. */
function hasNewAccount(accounts: readonly AppAccount[], pending: PendingSignIn): boolean {
  return accounts.some(
    (entry) =>
      entry.slug === pending.slug && entry.status === "connected" && !pending.known.includes(entry.id),
  );
}
