import type { PluginTheme } from "@getpaseo/plugin";
import { Text, View } from "react-native";
import type { DraftConflict } from "./bot-drafts";
import { Button } from "./panel/controls";

export interface DraftRecoveryProps {
  colors: PluginTheme["colors"];
  botIds: readonly string[];
  conflicts: Readonly<Record<string, DraftConflict>>;
  saving: boolean;
  onRetry(): void;
  onDiscard(botId?: string): void;
  onDiscardAndReview(botId: string): void;
}

export function DraftRecovery({
  colors,
  botIds,
  conflicts,
  saving,
  onRetry,
  onDiscard,
  onDiscardAndReview,
}: DraftRecoveryProps) {
  if (!botIds.length) return null;
  return (
    <View style={{ gap: 12, padding: 12, borderColor: colors.border, borderWidth: 1, borderRadius: 8 }}>
      <Text accessibilityRole="header" style={{ color: colors.foreground }}>
        Unsaved bot edits
      </Text>
      <Text accessibilityRole="alert" style={{ color: colors.foregroundMuted }}>
        Edits were retained. Conflicting saved fields cannot be overwritten automatically. Discarding only
        removes unsaved edits; acknowledged pauses and other saved changes remain.
      </Text>
      {botIds.map((botId) => (
        <View key={botId} style={{ gap: 8 }}>
          <Text selectable style={{ color: colors.foreground }}>
            Bot: {botId}
          </Text>
          {conflicts[botId] ? (
            <Text accessibilityRole="alert" style={{ color: colors.statusDanger }}>
              {conflicts[botId].message}
            </Text>
          ) : null}
          <Button
            colors={colors}
            label="Discard draft and review"
            disabled={saving}
            onPress={() => onDiscardAndReview(botId)}
          />
        </View>
      ))}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button colors={colors} label="Retry saving" loading={saving} onPress={onRetry} />
        <Button
          colors={colors}
          label="Discard all unsaved edits"
          disabled={saving}
          onPress={() => onDiscard()}
        />
      </View>
    </View>
  );
}
