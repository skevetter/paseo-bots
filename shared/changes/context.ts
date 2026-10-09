export interface ProviderInfo {
  id: string;
  models: { id: string; label: string; isDefault: boolean; thinking: string[] }[];
  modes: { id: string; label: string }[];
  defaultModeId: string | null;
}

export interface AppAccountInfo {
  id: string;
  slug: string;
  names: string[];
}

/** The fields of Paseo's provider snapshot entry that changes need. */
interface ProviderEntry {
  provider: string;
  enabled: boolean;
  status: string;
  models?: readonly {
    id: string;
    label: string;
    isDefault?: boolean;
    isSelectable?: boolean;
    thinkingOptions?: readonly { id: string }[];
  }[];
  modes?: readonly { id: string; label: string }[];
  defaultModeId?: string | null;
}

export function providerInfo(entries: readonly ProviderEntry[]): ProviderInfo[] {
  return entries
    .filter((entry) => entry.enabled)
    .map((entry) => ({
      id: entry.provider,
      models: (entry.models ?? [])
        .filter((model) => model.isSelectable !== false)
        .map((model) => ({
          id: model.id,
          label: model.label,
          isDefault: !!model.isDefault,
          thinking: (model.thinkingOptions ?? []).map((option) => option.id),
        })),
      modes: (entry.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label })),
      defaultModeId: entry.defaultModeId ?? null,
    }));
}

export function readyProvider(entries: readonly ProviderEntry[]): string {
  const ready = entries.filter((entry) => entry.enabled && entry.status === "ready");
  return (ready.find((entry) => entry.provider === "claude") ?? ready[0])?.provider ?? "";
}

export interface ApplyContext {
  now: string;
  /** For new bots when neither the change nor the defaults name one. */
  provider: string;
  /** When known, provider, model, mode and thinking ids are checked against it. */
  providers?: readonly ProviderInfo[] | null;
  /** When known, app account names are resolved against it. */
  accounts?: readonly AppAccountInfo[] | null;
}

type ProviderModel = ProviderInfo["models"][number];

function checkModel(provider: ProviderInfo, modelId: string | null): ProviderModel | null {
  if (!modelId) return null;
  const model = provider.models.find((entry) => entry.id === modelId);
  if (!model)
    throw new Error(
      `${provider.id} has no model "${modelId}". Use one of: ${provider.models.map((entry) => entry.id).join(", ")}.`,
    );
  return model;
}

function checkThinking(
  provider: ProviderInfo,
  model: ProviderModel | null,
  thinkingOptionId: string | null,
): void {
  const thinking = (model ?? provider.models.find((entry) => entry.isDefault))?.thinking ?? [];
  if (thinkingOptionId && !thinking.includes(thinkingOptionId)) {
    throw new Error(
      `That model has no thinking option "${thinkingOptionId}". Use one of: ${thinking.join(", ") || "none"}.`,
    );
  }
}

export function checkAgent(
  context: ApplyContext,
  fields: { provider: string; model: string | null; modeId: string | null; thinkingOptionId: string | null },
): void {
  const providers = context.providers;
  if (!providers || !fields.provider) return;
  const provider = providers.find((entry) => entry.id === fields.provider);
  if (!provider)
    throw new Error(
      `There's no provider "${fields.provider}". Use one of: ${providers.map((entry) => entry.id).join(", ")}.`,
    );
  const model = checkModel(provider, fields.model);
  if (fields.modeId && !provider.modes.some((mode) => mode.id === fields.modeId)) {
    throw new Error(
      `${provider.id} has no mode "${fields.modeId}". Use one of: ${provider.modes.map((mode) => mode.id).join(", ") || "none"}.`,
    );
  }
  checkThinking(provider, model, fields.thinkingOptionId);
}

export function accountId(slug: string, ref: string, context: ApplyContext): string {
  const accounts = context.accounts;
  // Proposals store the id once the host resolved it.
  if (!accounts) return ref;
  const mine = accounts.filter((account) => account.slug === slug);
  const key = ref.trim().toLowerCase();
  const found =
    mine.find((account) => account.id === ref.trim()) ??
    mine.find((account) => account.names.some((name) => name.toLowerCase() === key));
  if (!found)
    throw new Error(
      mine.length
        ? `${slug} has no account called "${ref}". Its accounts: ${mine.flatMap((account) => account.names.slice(0, 1)).join(", ")}.`
        : `${slug} isn't connected yet.`,
    );
  return found.id;
}
