import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, Text, View } from "react-native";
import { CONTENT_MAX_WIDTH, nativeTokens } from "../../native";
import { ui } from "../../typography";
import { tooltip } from "../../ui/Tooltip";
import { SecondaryButton } from "./buttons";

type Colors = PluginTheme["colors"];

export function OlderSpinner({ colors }: { colors: Colors }) {
  return (
    <View style={{ paddingVertical: 12, alignItems: "center" }}>
      <ActivityIndicator size="small" color={colors.foregroundMuted} />
    </View>
  );
}

export function LoadingOverlay({ colors }: { colors: Colors }) {
  return (
    <View
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        backgroundColor: colors.surface0,
        alignItems: "center",
        justifyContent: "center",
        zIndex: 40,
      }}
    >
      <ActivityIndicator size="large" color={colors.foregroundMuted} />
    </View>
  );
}

function useFadeIn(visible: boolean) {
  const opacity = useRef(new Animated.Value(visible ? 1 : 0)).current;
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    const target = visible ? 1 : 0;
    if (visible) setMounted(true);
    if (Platform.OS === "android") {
      opacity.setValue(target);
      if (!visible) setMounted(false);
      return;
    }
    const animation = Animated.timing(opacity, {
      toValue: target,
      duration: 200,
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start(({ finished }) => finished && !visible && setMounted(false));
    return () => animation.stop();
  }, [visible, opacity]);
  return { opacity, mounted };
}

export function ScrollToBottomButton({
  colors,
  visible,
  onPress,
}: {
  colors: Colors;
  visible: boolean;
  onPress(): void;
}) {
  const { opacity, mounted } = useFadeIn(visible);
  if (!mounted) return null;
  const tokens = nativeTokens(colors);
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, bottom: 16, alignItems: "center" }}
    >
      <Animated.View style={{ opacity }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Scroll to bottom"
          {...tooltip("Scroll to bottom")}
          onPress={onPress}
          style={{
            width: 48,
            height: 48,
            borderRadius: 24,
            backgroundColor: colors.surface2,
            alignItems: "center",
            justifyContent: "center",
            shadowColor: tokens.dark ? "rgba(0, 0, 0, 0.25)" : "rgba(0, 0, 0, 0.02)",
            shadowOffset: { width: 0, height: 2 },
            shadowRadius: tokens.dark ? 4 : 8,
            shadowOpacity: 1,
            elevation: 2,
          }}
        >
          <Icon name="ChevronDown" size={24} color={colors.foreground} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

export function SyncErrorCallout({
  colors,
  retrying,
  onRetry,
}: {
  colors: Colors;
  retrying: boolean;
  onRetry(): void;
}) {
  return (
    <View style={{ width: "100%", alignItems: "center", paddingHorizontal: 16, paddingTop: 8 }}>
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: colors.statusDanger,
            borderRadius: 16,
            paddingVertical: 8,
            paddingHorizontal: 16,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>
            Couldn't refresh agent history.
          </Text>
          <SecondaryButton
            colors={colors}
            label={retrying ? "Retrying…" : "Retry"}
            disabled={retrying}
            onPress={onRetry}
          />
        </View>
      </View>
    </View>
  );
}

/** The plugin API can't unarchive an agent, so unlike Paseo there's no Unarchive button. */
export function ArchivedCallout({ colors, compact }: { colors: Colors; compact: boolean }) {
  return (
    <View style={{ width: "100%", alignItems: "center", paddingHorizontal: 16, paddingTop: 16 }}>
      <View style={{ width: "100%", maxWidth: CONTENT_MAX_WIDTH }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            backgroundColor: colors.surface1,
            borderWidth: 1,
            borderColor: nativeTokens(colors).borderAccent,
            borderRadius: 16,
            paddingVertical: compact ? 12 : 16,
            paddingHorizontal: compact ? 16 : 24,
          }}
        >
          <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>This agent is archived</Text>
        </View>
      </View>
    </View>
  );
}
