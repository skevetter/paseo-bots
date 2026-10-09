import type { PluginTheme } from "@getpaseo/plugin";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { nativeTokens, useHover } from "../../native";
import { speak, stopSpeaking, useSpeaking } from "../../speech";
import { ui } from "../../typography";
import { tooltip } from "../../ui/Tooltip";
import { Spinner } from "./ui";

type Colors = PluginTheme["colors"];

export const CopyButton = memo(function CopyButton({
  colors,
  getContent,
  label,
  style,
}: {
  colors: Colors;
  getContent(): string;
  label: string;
  style?: object;
}) {
  const [copied, setCopied] = useState(false);
  const { hovered, hoverProps } = useHover();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const copy = () => {
    const text = getContent();
    if (!text) return;
    void copyText(text).then(() => {
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : label}
      {...tooltip(copied ? "Copied" : "Copy")}
      onPress={copy}
      {...hoverProps}
      style={[{ padding: 4 }, style]}
    >
      <Icon
        name={copied ? "Check" : "Copy"}
        size={14}
        color={hovered ? colors.foreground : colors.foregroundMuted}
      />
    </Pressable>
  );
});

export function SpeakButton({ colors, text, voice }: { colors: Colors; text: string; voice: string | null }) {
  const speaking = useSpeaking(text);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={speaking ? "Stop reading" : "Read aloud"}
      {...tooltip(speaking ? "Stop reading" : "Read aloud")}
      onPress={() => (speaking ? stopSpeaking() : speak(text, text, voice))}
      {...hoverProps}
      style={{ padding: 4, alignSelf: "center" }}
    >
      <Icon
        name={speaking ? "Square" : "Volume2"}
        size={14}
        color={hovered || speaking ? colors.foreground : colors.foregroundMuted}
      />
    </Pressable>
  );
}

export function SecondaryButton({
  colors,
  label,
  disabled,
  onPress,
}: {
  colors: Colors;
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  const tokens = nativeTokens(colors);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 32,
        paddingHorizontal: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: tokens.surface3,
        backgroundColor: tokens.surface3,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      })}
    >
      <Text style={{ fontSize: ui(14), color: colors.foreground }}>{label}</Text>
    </Pressable>
  );
}

export function CardButton({
  colors,
  label,
  icon,
  primary = false,
  busy = false,
  spinning = false,
  onPress,
}: {
  colors: Colors;
  label: string;
  icon: string;
  primary?: boolean;
  busy?: boolean;
  spinning?: boolean;
  onPress(): void;
}) {
  const [hovered, setHovered] = useState(false);
  const tint = primary ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={busy}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 6,
        alignItems: "center",
        borderWidth: 1,
        backgroundColor: hovered ? colors.surface2 : colors.surface1,
        borderColor: nativeTokens(colors).borderAccent,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      {spinning ? (
        <Spinner color={tint} />
      ) : (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={icon} size={14} color={tint} />
          <Text style={{ fontSize: ui(14), color: tint }}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}
