import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef, useState } from "react";
import {
  ActivityIndicator,
  type LayoutRectangle,
  Platform,
  Pressable,
  type StyleProp,
  Text,
  type TextInputProps,
  useWindowDimensions,
  View,
  type ViewStyle,
} from "react-native";
import { MONO_FONT, MONO_PROPS, nativeTokens, useHover, withAlpha } from "../native";
import { fieldStateStyle, multilineStyle } from "../theme";
import { code, ui } from "../typography";
import { measureAnchor } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";

// Paseo primitives the plugin SDK doesn't export, rebuilt to match their source.

type Colors = PluginTheme["colors"];

const isWeb = Platform.OS === "web";

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

type AreaProps = Omit<TextInputProps, "style" | "multiline"> & {
  colors: Colors;
  minHeight?: number;
  monospace?: boolean;
};

export function FormTextArea({
  colors,
  minHeight = 96,
  monospace,
  onFocus,
  onBlur,
  editable,
  ...props
}: AreaProps) {
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(false);
  return (
    <Pressable disabled={editable === false} {...hoverProps} style={{ width: "100%" }} accessible={false}>
      <TextInput
        {...props}
        {...(monospace ? MONO_PROPS : {})}
        editable={editable}
        multiline
        placeholderTextColor={colors.foregroundMuted}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          multilineStyle(colors, minHeight, monospace),
          fieldStateStyle(colors, { hovered, focused, disabled: editable === false }),
        ]}
      />
    </Pressable>
  );
}

/** Render inside a SettingsCard. */
export function TextAreaField({
  colors,
  label,
  hint,
  error,
  ...props
}: AreaProps & { label?: string; hint?: string | null; error?: string | null }) {
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      {label ? <RowText colors={colors} label={label} hint={hint} /> : null}
      <FormTextArea colors={colors} accessibilityLabel={label} {...props} />
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

interface InputFieldProps extends Omit<TextInputProps, "style" | "multiline" | "defaultValue" | "value"> {
  colors: Colors;
  label: string;
  hint?: string | null;
  error?: string | null;
  /** Uncontrolled; remount with a `key` to reset it. */
  initialValue?: string;
  monospace?: boolean;
  disabled?: boolean;
}

/**
 * Unlike Paseo's SettingsInput, the input spans the row under its label; beside
 * it, the input is cramped in the 320-wide panel and short on phones.
 */
export function InputField({
  colors,
  label,
  hint,
  error,
  initialValue,
  monospace,
  disabled,
  onFocus,
  onBlur,
  ...props
}: InputFieldProps) {
  const compact = useCompact();
  const { hovered, hoverProps } = useHover();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ paddingVertical: 16, paddingHorizontal: 16, gap: 12 }}>
      <RowText colors={colors} label={label} hint={hint} />
      <Pressable disabled={disabled} {...hoverProps} accessible={false} style={{ width: "100%" }}>
        <TextInput
          accessibilityLabel={label}
          {...props}
          {...(monospace ? MONO_PROPS : {})}
          defaultValue={initialValue}
          editable={!disabled}
          placeholderTextColor={colors.foregroundMuted}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          style={[
            {
              width: "100%",
              height: compact ? 44 : 32,
              paddingHorizontal: 12,
              borderRadius: compact ? 8 : 6,
              borderWidth: 1,
              borderColor: "transparent",
              backgroundColor: colors.surface2,
              color: colors.foreground,
              fontSize: monospace ? code() : ui(14),
              fontFamily: monospace ? MONO_FONT : undefined,
              outlineWidth: 0,
              outlineColor: "transparent",
            },
            fieldStateStyle(colors, { hovered, focused, disabled }),
          ]}
        />
      </Pressable>
      {error ? (
        <Text accessibilityRole="alert" style={{ fontSize: ui(12), color: colors.statusDanger }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}

export function SearchField({
  colors,
  value,
  onChangeText,
  placeholder,
}: {
  colors: Colors;
  value: string;
  onChangeText(text: string): void;
  placeholder: string;
}) {
  const [focused, setFocused] = useState(false);
  const tokens = nativeTokens(colors);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 12,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: focused ? tokens.borderAccent : colors.border,
        backgroundColor: focused ? colors.surface2 : colors.surface1,
      }}
    >
      <Icon name="Search" size={14} color={colors.foregroundMuted} />
      <TextInput
        accessibilityLabel={placeholder}
        value={value}
        onChangeText={onChangeText}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        placeholderTextColor={colors.foregroundMuted}
        selectionColor={colors.foreground}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={{
          flex: 1,
          minWidth: 0,
          padding: 0,
          height: 20,
          fontSize: ui(14),
          color: colors.foreground,
          outlineWidth: 0,
        }}
      />
      {value.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          {...tooltip("Clear search")}
          hitSlop={8}
          onPress={() => onChangeText("")}
        >
          <Icon name="X" size={14} color={colors.foregroundMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

const ALERT_ICONS = { default: null, warning: "AlertTriangle", error: "CircleX" } as const;

type AlertVariant = keyof typeof ALERT_ICONS;

function alertAccent(colors: Colors, variant: AlertVariant): string | null {
  const accents: Record<AlertVariant, string | null> = {
    default: null,
    warning: colors.statusWarning,
    error: colors.statusDanger,
  };
  return accents[variant];
}

function descriptionLines(description: string | string[] | undefined): string[] {
  if (description === undefined) return [];
  return Array.isArray(description) ? description : [description];
}

function withOccurrenceKeys(lines: string[]): { key: string; line: string }[] {
  const seen = new Map<string, number>();
  return lines.map((line) => {
    const occurrence = seen.get(line) ?? 0;
    seen.set(line, occurrence + 1);
    return { key: `${line}#${occurrence}`, line };
  });
}

function AlertHeading({
  colors,
  accent,
  icon,
  title,
  fallback,
}: {
  colors: Colors;
  accent: string | null;
  icon: string | null;
  title?: string;
  fallback: ReactNode;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      {icon ? (
        <View style={{ width: 14, alignItems: "center" }}>
          <Icon name={icon} size={14} color={accent ?? colors.foreground} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? (
          <Text style={{ fontSize: ui(14), fontWeight: "500", color: accent ?? colors.foreground }}>
            {title}
          </Text>
        ) : (
          fallback
        )}
      </View>
    </View>
  );
}

export function Alert({
  colors,
  variant = "default",
  title,
  description,
}: {
  colors: Colors;
  variant?: AlertVariant;
  title?: string;
  description?: string | string[];
}) {
  const accent = alertAccent(colors, variant);
  const icon = ALERT_ICONS[variant];
  const body = withOccurrenceKeys(descriptionLines(description)).map(({ key, line }) => (
    <Text key={key} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
      {line}
    </Text>
  ));
  const rest = title ? body : body.slice(1);
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderWidth: 1,
        borderColor: accent ? withAlpha(accent, 0.5) : colors.border,
        backgroundColor: "transparent",
        borderRadius: 16,
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 2,
      }}
    >
      <AlertHeading colors={colors} accent={accent} icon={icon} title={title} fallback={body[0]} />
      {rest.length ? <View style={{ marginLeft: icon ? 26 : 0 }}>{rest}</View> : null}
    </View>
  );
}

export type BadgeVariant = "success" | "warning" | "error" | "muted";

function badgeStatus(colors: Colors, variant: BadgeVariant): string | null {
  const statuses: Record<BadgeVariant, string | null> = {
    success: colors.statusSuccess,
    warning: colors.statusWarning,
    error: colors.statusDanger,
    muted: null,
  };
  return statuses[variant];
}

export function StatusBadge({
  colors,
  label,
  variant = "muted",
}: {
  colors: Colors;
  label: string;
  variant?: BadgeVariant;
}) {
  const tokens = nativeTokens(colors);
  const status = badgeStatus(colors, variant);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: status ? "transparent" : colors.border,
        backgroundColor: status ? withAlpha(status, tokens.dark ? 0.16 : 0.12) : tokens.surface3,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <Text style={{ fontSize: ui(12), color: status ?? colors.foregroundMuted }}>{label}</Text>
    </View>
  );
}

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
