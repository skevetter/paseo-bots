import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef } from "react";
import { ActivityIndicator, type LayoutRectangle, Platform, Pressable, Text, View } from "react-native";
import { nativeTokens, useHover } from "../native";
import { ui } from "../typography";
import { measureAnchor } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";

// Paseo primitives the plugin SDK doesn't export, rebuilt to match their source.

type Colors = PluginTheme["colors"];

const isWeb = Platform.OS === "web";

export function Switch({
  colors,
  value,
  onValueChange,
  label,
  disabled,
}: {
  colors: Colors;
  value: boolean;
  onValueChange(value: boolean): void;
  label: string;
  disabled?: boolean;
}) {
  const tokens = nativeTokens(colors);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled: !!disabled }}
      aria-checked={value}
      disabled={disabled}
      hitSlop={8}
      // Inside a pressable row: keep the row's own press from firing.
      onPressIn={(event) => event.stopPropagation()}
      onPress={() => onValueChange(!value)}
      style={{ minHeight: 32, justifyContent: "center", opacity: disabled ? 0.5 : 1 }}
    >
      <View
        style={{
          width: 34,
          height: 20,
          borderRadius: 10,
          padding: 2,
          justifyContent: "center",
          backgroundColor: value ? colors.accent : tokens.surface3,
        }}
      >
        <View
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: value ? colors.accentForeground : "#ffffff",
            transform: [{ translateX: value ? 14 : 0 }],
            shadowColor: "rgba(0, 0, 0, 0.25)",
            shadowOffset: { width: 0, height: 1 },
            shadowRadius: 2,
            shadowOpacity: 1,
            elevation: 2,
          }}
        />
      </View>
    </Pressable>
  );
}

export function RowText({
  colors,
  label,
  hint,
  error,
  hintLines,
}: {
  colors: Colors;
  label: string;
  hint?: string | null;
  error?: string | null;
  hintLines?: number;
}) {
  return (
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ fontSize: ui(14), color: colors.foreground }}>
        {label}
      </Text>
      {hint ? (
        <Text
          numberOfLines={hintLines}
          style={{ fontSize: ui(12), color: colors.foregroundMuted, marginTop: 4 }}
        >
          {hint}
        </Text>
      ) : null}
      {error ? (
        <Text
          accessibilityRole="alert"
          style={{ fontSize: ui(12), color: colors.statusDanger, marginTop: 4 }}
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/** Render as a direct SettingsCard child so the card draws the divider. */
export function PressableRow({
  colors,
  onPress,
  accessibilityLabel,
  children,
}: {
  colors: Colors;
  onPress(): void;
  accessibilityLabel: string;
  children: (state: { hovered: boolean }) => ReactNode;
}) {
  const tokens = nativeTokens(colors);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 16,
        paddingHorizontal: 16,
        backgroundColor: pressed ? tokens.surface3 : hovered && isWeb ? colors.surface2 : "transparent",
      })}
    >
      {children({ hovered })}
    </Pressable>
  );
}

export function DrillRow({
  colors,
  label,
  hint,
  error,
  trailing,
  onPress,
  hintLines = 1,
}: {
  colors: Colors;
  label: string;
  hint?: string | null;
  error?: string | null;
  trailing?: ReactNode;
  onPress(): void;
  hintLines?: number;
}) {
  return (
    <PressableRow colors={colors} onPress={onPress} accessibilityLabel={label}>
      {({ hovered }) => (
        <>
          <RowText colors={colors} label={label} hint={hint} error={error} hintLines={hintLines} />
          {trailing}
          <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
        </>
      )}
    </PressableRow>
  );
}

export function AdvancedToggle({
  colors,
  open,
  onToggle,
}: {
  colors: Colors;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={open ? "Hide advanced" : "Show advanced"}
      accessibilityState={{ expanded: open }}
      onPress={onToggle}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        alignSelf: "flex-start",
        paddingVertical: 4,
        marginBottom: open ? 16 : 0,
      }}
    >
      <Icon name={open ? "ChevronDown" : "ChevronRight"} size={16} color={colors.foregroundMuted} />
      <Text style={{ fontSize: ui(14), fontWeight: "500", color: colors.foreground }}>Advanced</Text>
    </Pressable>
  );
}

export function StackedRow({
  colors,
  label,
  hint,
  children,
}: {
  colors: Colors;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      <RowText colors={colors} label={label} hint={hint} />
      {children}
    </View>
  );
}

export function CardNote({ colors, text, loading }: { colors: Colors; text: string; loading?: boolean }) {
  return (
    <View
      style={{ padding: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }}
    >
      {loading ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      <Text style={{ fontSize: ui(14), color: colors.foregroundMuted, textAlign: "center" }}>{text}</Text>
    </View>
  );
}

export function KebabButton({
  colors,
  label,
  onOpen,
}: {
  colors: Colors;
  label: string;
  onOpen(anchor: LayoutRectangle): void;
}) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label)}
      hitSlop={8}
      onPressIn={(event) => event.stopPropagation()}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onOpen(anchor))}
      {...hoverProps}
      style={{ padding: 4, borderRadius: 4, backgroundColor: hovered ? colors.surface2 : "transparent" }}
    >
      <Icon name="MoreVertical" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

export function SectionLink({
  colors,
  label,
  icon = "Plus",
  onPress,
}: {
  colors: Colors;
  label: string;
  icon?: string;
  onPress(anchor: LayoutRectangle | null): void;
}) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  const tint = hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      onPress={() => void measureAnchor(ref).then(onPress)}
      {...hoverProps}
      style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
    >
      <Icon name={icon} size={12} color={tint} />
      <Text style={{ fontSize: ui(12), color: tint }}>{label}</Text>
    </Pressable>
  );
}

export function SectionMeta({
  colors,
  text,
  tone,
}: {
  colors: Colors;
  text: string;
  tone?: "warning" | "danger";
}) {
  const color =
    tone === "danger"
      ? colors.statusDanger
      : tone === "warning"
        ? colors.statusWarning
        : colors.foregroundMuted;
  return <Text style={{ fontSize: ui(12), color }}>{text}</Text>;
}
