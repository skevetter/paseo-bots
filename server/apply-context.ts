import { DEFAULT_BOT_DEFAULTS } from "../shared/bot";
import type { ProviderModesById } from "../shared/bot-checks";
import {
  type AppAccountInfo,
  type ApplyContext,
  type ProviderInfo,
  providerInfo,
  readyProvider,
} from "../shared/changes/context";
import { accounts, status } from "./composio";
import type { BotsHost } from "./host";
import type { NewBotStart } from "./share";

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

export interface HostProviders {
  /** For new bots when neither the change nor the defaults name one. */
  provider: string;
  providers: ProviderInfo[] | null;
  modes: ProviderModesById;
}

export async function hostProviders(host: BotsHost): Promise<HostProviders> {
  const snapshot = await host.paseo?.providers.snapshot().catch(() => null);
  return {
    provider: snapshot ? readyProvider(snapshot.entries) : "",
    providers: snapshot ? providerInfo(snapshot.entries) : null,
    modes: Object.fromEntries((snapshot?.entries ?? []).map((entry) => [entry.provider, entry])),
  };
}

export async function newBotStart(host: BotsHost): Promise<NewBotStart> {
  const { defaults } = await host.values();
  return { defaults: defaults ?? DEFAULT_BOT_DEFAULTS, modes: (await hostProviders(host)).modes };
}

/** Checks changes against the providers and app accounts on this host, as far as they're known. */
export async function applyContext(host: BotsHost): Promise<ApplyContext & { modes: ProviderModesById }> {
  return { now: new Date().toISOString(), ...(await hostProviders(host)), accounts: await appAccounts() };
}
