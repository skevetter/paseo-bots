import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo } from "react";
import { Text, View } from "react-native";
import { ui } from "../../typography";
import { METADATA_SIZE, Spinner } from "./ui";

type Colors = PluginTheme["colors"];

const NOTIFICATION_STYLES = {
  info: { background: "rgba(147, 197, 253, 0.1)", icon: "Info", tint: "#93c5fd" },
  warning: { background: "rgba(245, 158, 11, 0.1)", icon: "TriangleAlert", tint: "#f59e0b" },
  error: { background: "rgba(239, 68, 68, 0.1)", icon: "CircleX", tint: "" },
} as const;

export const Notification = memo(function Notification({
  colors,
  level,
  message,
}: {
  colors: Colors;
  level: "info" | "warning" | "error";
  message: string;
}) {
  const style = NOTIFICATION_STYLES[level];
  return (
    <View style={{ borderRadius: 6, overflow: "hidden", backgroundColor: style.background }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flexShrink: 0, height: 20, justifyContent: "center" }}>
            <Icon name={style.icon} size={16} color={style.tint || colors.statusDanger} />
          </View>
          <View style={{ flex: 1 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: ui(14), lineHeight: 20 }}>
              {message}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
});

function compactionLabel(
  status: "loading" | "completed",
  trigger?: "auto" | "manual",
  preTokens?: number,
): string {
  if (status === "loading") return "Compacting...";
  if (trigger === "auto") return "Context automatically compacted";
  if (trigger === "manual") return "Context manually compacted";
  if (preTokens) return `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  return "Context compacted";
}

export const CompactionMarker = memo(function CompactionMarker({
  colors,
  status,
  trigger,
  preTokens,
}: {
  colors: Colors;
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 8,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {status === "loading" ? (
          <Spinner color="#a1a1aa" />
        ) : (
          <Icon name="Scissors" size={12} color="#a1a1aa" />
        )}
        <Text style={{ fontSize: METADATA_SIZE, color: colors.foregroundMuted }}>
          {compactionLabel(status, trigger, preTokens)}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
});
