import {
  type AppAccountInfo,
  type ApplyContext,
  providerInfo,
  readyProvider,
} from "../shared/changes/context";
import type { ProviderModesById } from "../shared/elevated";
import { accounts, status } from "./composio";
import type { BotsHost } from "./host";

async function appAccounts(): Promise<AppAccountInfo[] | null> {
  if (!(await status()).configured) return null;
  // Accounts go by the names the user gave them, or Composio's word ids; their sign-in (an email) only matches.
  const list = await accounts().catch(() => null);
  return list
    ? list.accounts.map((account) => ({
        id: account.id,
        slug: account.slug,
        names: [account.alias, account.wordId, account.name].filter((name): name is string => !!name),
      }))
    : null;
}

/** Checks changes against the providers and app accounts on this host, as far as they're known. */
export async function applyContext(host: BotsHost): Promise<ApplyContext & { modes: ProviderModesById }> {
  const snapshot = await host.paseo?.providers.snapshot().catch(() => null);
  return {
    now: new Date().toISOString(),
    provider: snapshot ? readyProvider(snapshot.entries) : "",
    providers: snapshot ? providerInfo(snapshot.entries) : null,
    accounts: await appAccounts(),
    modes: Object.fromEntries((snapshot?.entries ?? []).map((entry) => [entry.provider, entry])),
  };
}
