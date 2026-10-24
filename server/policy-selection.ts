import { defaultModelId } from "../shared/bot-agent";
import type { ProviderInfo } from "../shared/changes/context";
import type { Issue, Resolution } from "../shared/policies";

/** Uses the same selectable default as chat launch, including providers without an explicit default flag. */
export function selectionIssues(resolution: Resolution, providers: readonly ProviderInfo[] | null): Issue[] {
  const issue = (field: string, message: string): Issue[] => [
    { code: "capability_unsupported", field, message },
  ];
  if (!providers)
    return [
      {
        code: "approval_unverifiable",
        field: "provider",
        message: "Host provider evidence is unavailable. Reconnect and preview again.",
      },
    ];
  const provider = providers.find((entry) => entry.id === resolution.provider.value);
  if (!provider)
    return [
      {
        code: "provider_unresolved",
        field: "provider",
        message: "The selected provider is unavailable on this host.",
      },
    ];
  const model = resolution.model.value ?? defaultModelId(provider.models);
  if (!model) return issue("model", `${provider.id} has no selectable models.`);
  const selected = provider.models.find((entry) => entry.id === model);
  if (!selected) return issue("model", `${provider.id} has no selectable model ${model}.`);
  const mode = resolution.modeId.value;
  if (mode && !provider.modes.some((entry) => entry.id === mode))
    return [
      { code: "mode_not_on_provider", field: "modeId", message: `${provider.id} has no mode ${mode}.` },
    ];
  const thinking = resolution.thinkingOptionId.value;
  return thinking && !selected.thinking.includes(thinking)
    ? issue("thinkingOptionId", `The selected model has no thinking option ${thinking}.`)
    : [];
}
