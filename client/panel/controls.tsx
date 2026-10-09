import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  Text,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { nativeTokens, useHover } from "../native";
import { ui } from "../typography";

// Paseo primitives the plugin SDK doesn't export, rebuilt to match their source.

type Colors = PluginTheme["colors"];

/** Paseo's compact breakpoint (unistyles xs/sm). */
export function useCompact(compact?: boolean): boolean {
  const { width } = useWindowDimensions();
  return compact ?? width < 720;
}

type ButtonVariant = "default" | "secondary" | "outline" | "ghost";
type ButtonSize = "xs" | "sm" | "md";

const BUTTON_SIZES: Record<
  ButtonSize,
  { minHeight: number; paddingHorizontal: number; borderRadius: number; iconSize: number; fontSize: number }
> = {
  xs: { minHeight: 28, paddingHorizontal: 12, borderRadius: 12, iconSize: 14, fontSize: 12 },
  sm: { minHeight: 32, paddingHorizontal: 12, borderRadius: 12, iconSize: 14, fontSize: 14 },
  md: { minHeight: 44, paddingHorizontal: 16, borderRadius: 16, iconSize: 16, fontSize: 14 },
};

function buttonPalette(colors: Colors, variant: ButtonVariant, hovered: boolean) {
  const tokens = nativeTokens(colors);
  const palettes: Record<ButtonVariant, { fill: string; border: string; tint: string }> = {
    default: { fill: colors.accent, border: colors.accent, tint: colors.accentForeground },
    secondary: { fill: tokens.surface3, border: tokens.surface3, tint: colors.foreground },
    outline: { fill: "transparent", border: tokens.borderAccent, tint: colors.foreground },
    ghost: {
      fill: "transparent",
      border: "transparent",
      tint: hovered ? colors.foreground : colors.foregroundMuted,
    },
  };
  return palettes[variant];
}

function buttonOpacity(inactive: boolean | undefined, pressed: boolean): number {
  if (inactive) return 0.5;
  return pressed ? 0.85 : 1;
}

function ButtonGlyph({
  loading,
  icon,
  size,
  tint,
}: {
  loading?: boolean;
  icon?: string;
  size: number;
  tint: string;
}) {
  if (loading) return <ActivityIndicator size="small" color={tint} />;
  if (icon) return <Icon name={icon} size={size} color={tint} />;
  return null;
}

export function Button({
  colors,
  label,
  onPress,
  variant = "secondary",
  size = "sm",
  disabled,
  loading,
  icon,
  style,
}: {
  colors: Colors;
  label: string;
  onPress(): void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  loading?: boolean;
  icon?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { hovered, hoverProps } = useHover();
  const inactive = disabled || loading;
  const { fill, border, tint } = buttonPalette(colors, variant, hovered);
  const { minHeight, paddingHorizontal, borderRadius, iconSize, fontSize } = BUTTON_SIZES[size];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => [
        {
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          borderWidth: 1,
          borderColor: border,
          backgroundColor: fill,
          minHeight,
          paddingHorizontal,
          borderRadius,
          opacity: buttonOpacity(inactive, pressed),
        },
        style,
      ]}
    >
      <ButtonGlyph loading={loading} icon={icon} size={iconSize} tint={tint} />
      <Text numberOfLines={1} style={{ fontSize: ui(fontSize), color: tint }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function SheetFooter({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", gap: 12 }}>{children}</View>;
}

export function SheetActions({ children, leading }: { children: ReactNode; leading?: ReactNode }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <View style={{ flex: 1, minWidth: 0, alignItems: "flex-start" }}>{leading}</View>
      {children}
    </View>
  );
}
