import type { PluginTheme } from "@getpaseo/plugin";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import type { McpServerConfig } from "../../shared/bot";
import { BROWSER_DESCRIPTION, browserUrlOf, DEFAULT_BROWSER_URL, withBrowserUrl } from "../../shared/browser";
import { InputField } from "../panel/fields";
import { Alert } from "../panel/status";

type Colors = PluginTheme["colors"];

export function BrowserSection({
  colors,
  config,
  onConfig,
}: {
  colors: Colors;
  config: McpServerConfig;
  onConfig(config: McpServerConfig): void;
}) {
  const saved = browserUrlOf(config) ?? DEFAULT_BROWSER_URL;
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    const next = draft.trim() || DEFAULT_BROWSER_URL;
    if (next !== saved) onConfig(withBrowserUrl(config, next));
  };
  return (
    <View style={{ marginBottom: 24, gap: 12 }}>
      <Alert colors={colors} variant="warning" title="Acts as you" description={BROWSER_DESCRIPTION} />
      <SettingsSection title="Browser">
        <SettingsCard>
          <InputField
            key={saved}
            colors={colors}
            label="Browser address"
            hint="The remote debugging address of a browser started with --remote-debugging-port"
            initialValue={saved}
            placeholder={DEFAULT_BROWSER_URL}
            autoCapitalize="none"
            autoCorrect={false}
            monospace
            onChangeText={setDraft}
            onSubmitEditing={commit}
            onBlur={commit}
          />
        </SettingsCard>
      </SettingsSection>
    </View>
  );
}
