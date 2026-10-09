import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, type TextInputProps, View } from "react-native";
import { MONO_FONT, MONO_PROPS, nativeTokens, useHover } from "../native";
import { fieldStateStyle, multilineStyle } from "../theme";
import { code, ui } from "../typography";
import { tooltip } from "../ui/Tooltip";
import { useCompact } from "./controls";
import { RowText } from "./rows";

// Paseo primitives the plugin SDK doesn't export, rebuilt to match their source.

type Colors = PluginTheme["colors"];

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
