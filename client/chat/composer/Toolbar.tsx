import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode, RefObject } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { useHover } from "../../native";
import { tooltip } from "../../ui/Tooltip";
import { ContextMeter } from "./ContextMeter";
import type { ContextUsage, PrimaryActionKind } from "./logic";

type Colors = PluginTheme["colors"];

const RED_600 = "#dc2626";

interface PrimaryButtonProps {
  colors: Colors;
  primary: PrimaryActionKind;
  iconSize: number;
  sendLabel: string;
  sendDisabled: boolean;
  loading: boolean;
  canInterrupt: boolean;
  stopping: boolean;
  onSend(): void;
  onStop(): void;
}

export function PrimaryButton({
  colors,
  primary,
  iconSize,
  sendLabel,
  sendDisabled,
  loading,
  canInterrupt,
  stopping,
  onSend,
  onStop,
}: PrimaryButtonProps) {
  if (primary === "send") {
    return (
      <RoundButton label={sendLabel} background={colors.accent} disabled={sendDisabled} onPress={onSend}>
        {loading ? (
          <ActivityIndicator size="small" color={colors.accentForeground} />
        ) : (
          <Icon name="ArrowUp" size={iconSize} color={colors.accentForeground} />
        )}
      </RoundButton>
    );
  }
  if (primary !== "active" || !canInterrupt) return null;
  return (
    <RoundButton
      label={stopping ? "Canceling agent" : "Stop agent"}
      background={RED_600}
      disabled={stopping}
      onPress={onStop}
    >
      {stopping ? <ActivityIndicator size="small" color="#ffffff" /> : <FilledSquare size={iconSize} />}
    </RoundButton>
  );
}

export function ContextMeterSlot({
  colors,
  usage,
  pending,
  glyphSize,
}: {
  colors: Colors;
  usage: ContextUsage | null;
  pending: boolean;
  glyphSize: number;
}) {
  return (
    <View
      style={{
        width: 28,
        height: 28,
        flexShrink: 0,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <ContextMeter colors={colors} usage={usage} pending={pending} glyphSize={glyphSize} />
    </View>
  );
}

export function ComposerToolbar({
  colors,
  attachRef,
  iconSize,
  attachDisabled,
  onAttach,
  children,
}: {
  colors: Colors;
  attachRef: RefObject<View | null>;
  iconSize: number;
  attachDisabled: boolean;
  onAttach(): void;
  children: ReactNode;
}) {
  return (
    <View
      style={{
        flexShrink: 0,
        flexDirection: "row",
        alignItems: "flex-end",
        justifyContent: "space-between",
        marginHorizontal: -6,
      }}
    >
      <View
        style={{
          minWidth: 0,
          flexShrink: 1,
          flexGrow: 1,
          flexDirection: "row",
          alignItems: "flex-end",
        }}
      >
        <AttachButton
          colors={colors}
          anchorRef={attachRef}
          iconSize={iconSize}
          disabled={attachDisabled}
          onPress={onAttach}
        />
      </View>
      <View style={{ flexShrink: 0, flexDirection: "row", alignItems: "center", gap: 4 }}>{children}</View>
    </View>
  );
}

function AttachButton({
  colors,
  anchorRef,
  iconSize,
  disabled,
  onPress,
}: {
  colors: Colors;
  anchorRef: RefObject<View | null>;
  iconSize: number;
  disabled: boolean;
  onPress(): void;
}) {
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add attachment"
      {...tooltip("Add attachment")}
      disabled={disabled}
      onPress={onPress}
      {...hoverProps}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered ? colors.surface2 : "transparent",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <View
        ref={anchorRef}
        collapsable={false}
        style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}
      >
        <Icon name="Plus" size={iconSize} color={hovered ? colors.foreground : colors.foregroundMuted} />
      </View>
    </Pressable>
  );
}

function RoundButton({
  label,
  background,
  disabled,
  onPress,
  children,
}: {
  label: string;
  background: string;
  disabled: boolean;
  onPress(): void;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label)}
      disabled={disabled}
      onPress={onPress}
      style={{
        width: 28,
        height: 28,
        borderRadius: 14,
        marginLeft: 4,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: background,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </Pressable>
  );
}

/** The plugin Icon can't fill, so this draws Lucide's Square filled white. */
function FilledSquare({ size }: { size: number }) {
  const side = Math.round((size * 18) / 24);
  return (
    <View style={{ width: side, height: side, borderRadius: (size * 2) / 24, backgroundColor: "#ffffff" }} />
  );
}
