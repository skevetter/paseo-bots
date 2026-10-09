import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, type StyleProp, type TextStyle, View } from "react-native";
import { ui } from "../../typography";
import { isWeb } from "./ui";

type Colors = PluginTheme["colors"];

// This plugin typechecks without the DOM library.
interface StyleNode {
  id: string;
  textContent: string | null;
}
const dom = globalThis as unknown as {
  document?: {
    getElementById(id: string): StyleNode | null;
    createElement(tag: "style"): StyleNode;
    head?: { appendChild(node: StyleNode): void };
  };
};

function ensureStyle(id: string, css: string): void {
  const document = dom.document;
  if (!isWeb || !document?.head) return;
  const existing = document.getElementById(id);
  if (existing) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const node = document.createElement("style");
  node.id = id;
  node.textContent = css;
  document.head.appendChild(node);
}

const SHIMMER_CSS = `
@keyframes pbot-toolcall-shimmer { 0% { background-position: 120% 0; } 100% { background-position: -20% 0; } }
[data-pbot-shimmer] {
  color: inherit;
  background-image: linear-gradient(90deg, currentColor 0%, currentColor 38%, #ffffff 50%, currentColor 62%, currentColor 100%);
  background-size: 300% 100%;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation-name: pbot-toolcall-shimmer;
  animation-duration: 1.6s;
  animation-timing-function: linear;
  animation-iteration-count: infinite;
}`;

function shimmerDuration(label: string, secondary?: string): number {
  const chars = label.trim().length + (secondary?.trim().length ?? 0);
  const adjust = chars <= 12 ? 0.25 : 0;
  return Math.max(1, Math.min(2.3, 1.25 + chars * 0.008 - adjust));
}

interface Shimmer {
  textProps: object;
  style: StyleProp<TextStyle>;
}

/** Phones pulse the opacity instead of the web's gradient sweep: plugins have no masked views. */
function useShimmer(active: boolean, duration: number): Shimmer {
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!active) return;
    if (isWeb) {
      ensureStyle("pbot-toolcall-shimmer", SHIMMER_CSS);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: (duration * 1000) / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: (duration * 1000) / 2,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      opacity.setValue(1);
    };
  }, [active, duration, opacity]);
  if (!active) return { textProps: {}, style: null };
  if (isWeb) {
    return {
      textProps: { dataSet: { pbotShimmer: "" } },
      style: { animationDuration: `${duration.toFixed(2)}s` } as TextStyle,
    };
  }
  return { textProps: {}, style: { opacity } as unknown as TextStyle };
}

export interface ExpandableBadgeProps {
  colors: Colors;
  label: string;
  secondaryLabel?: string;
  icon?: string;
  isExpanded: boolean;
  onToggle?(): void;
  renderDetails?(): ReactNode;
  isLoading?: boolean;
  isError?: boolean;
}

function BadgeIcon({
  colors,
  icon,
  active,
  isExpanded,
  interactive,
  isError,
}: {
  colors: Colors;
  icon: string | undefined;
  active: boolean;
  isExpanded: boolean;
  interactive: boolean;
  isError: boolean;
}) {
  if (interactive && active) {
    return (
      <View
        style={{
          marginLeft: -4,
          transform: isExpanded ? [{ scale: 1.3 }, { rotate: "90deg" }] : [{ scale: 1.3 }],
        }}
      >
        <Icon name="ChevronRight" size={12} color={colors.foreground} />
      </View>
    );
  }
  if (isError) {
    return (
      <View style={{ marginLeft: -1, opacity: 0.8 }}>
        <Icon name="TriangleAlert" size={12} color={colors.statusDanger} />
      </View>
    );
  }
  if (icon) {
    return (
      <View style={{ marginLeft: -1 }}>
        <Icon name={icon} size={12} color={active ? colors.foreground : colors.foregroundMuted} />
      </View>
    );
  }
  return null;
}

function BadgeLabels({
  colors,
  label,
  secondaryLabel,
  active,
  isLoading,
  shimmer,
}: {
  colors: Colors;
  label: string;
  secondaryLabel: string | undefined;
  active: boolean;
  isLoading: boolean;
  shimmer: Shimmer;
}) {
  const labelStyle: TextStyle = {
    color: isLoading || active ? colors.foreground : colors.foregroundMuted,
    opacity: isLoading ? 0.72 : 1,
    fontSize: ui(14),
    flexShrink: 0,
  };
  return (
    <View style={{ flex: 1, flexDirection: "row", alignItems: "center", overflow: "hidden" }}>
      <Animated.Text numberOfLines={1} {...shimmer.textProps} style={[labelStyle, shimmer.style]}>
        {label}
      </Animated.Text>
      {secondaryLabel ? (
        <Animated.Text
          numberOfLines={1}
          {...shimmer.textProps}
          style={[
            {
              flexShrink: 1,
              minWidth: 0,
              marginLeft: 8,
              fontSize: ui(14),
              color: active ? colors.foreground : colors.foregroundMuted,
            },
            shimmer.style,
          ]}
        >
          {secondaryLabel}
        </Animated.Text>
      ) : null}
    </View>
  );
}

function BadgeDetails({ colors, children }: { colors: Colors; children: ReactNode }) {
  return (
    <View
      style={{
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 8,
        borderWidth: 1,
        borderTopWidth: 0,
        borderColor: colors.border,
        flexShrink: 1,
        minWidth: 0,
        overflow: "hidden",
        ...(isWeb ? ({ cursor: "auto", userSelect: "text" } as object) : {}),
      }}
    >
      {children}
    </View>
  );
}

export const ExpandableBadge = memo(function ExpandableBadge({
  colors,
  label,
  secondaryLabel,
  icon,
  isExpanded,
  onToggle,
  renderDetails,
  isLoading = false,
  isError = false,
}: ExpandableBadgeProps) {
  const [hovered, setHovered] = useState(false);
  const interactive = Boolean(onToggle);
  const active = hovered || isExpanded;
  const duration = shimmerDuration(label, secondaryLabel);
  const shimmer = useShimmer(isLoading, duration);
  const details = isExpanded && renderDetails ? renderDetails() : null;
  return (
    <View style={{ marginHorizontal: -13 }}>
      <Pressable
        accessibilityRole={interactive ? "button" : undefined}
        accessibilityLabel={secondaryLabel ? `${label} ${secondaryLabel}` : label}
        accessibilityState={interactive ? { expanded: isExpanded } : undefined}
        disabled={!interactive}
        onPress={onToggle}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        style={({ pressed }) => ({
          borderRadius: 8,
          borderWidth: 1,
          borderColor: isExpanded ? colors.border : "transparent",
          paddingHorizontal: 8,
          paddingVertical: 4,
          overflow: "hidden",
          opacity: pressed && interactive ? 0.9 : 1,
          ...(isExpanded
            ? { backgroundColor: colors.surface1, borderBottomLeftRadius: 0, borderBottomRightRadius: 0 }
            : {}),
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center" }}>
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 11,
              alignItems: "center",
              justifyContent: "center",
              marginRight: 4,
            }}
          >
            <BadgeIcon
              colors={colors}
              icon={icon}
              active={active}
              isExpanded={isExpanded}
              interactive={interactive}
              isError={isError}
            />
          </View>
          <BadgeLabels
            colors={colors}
            label={label}
            secondaryLabel={secondaryLabel}
            active={active}
            isLoading={isLoading}
            shimmer={shimmer}
          />
        </View>
      </Pressable>
      {details ? <BadgeDetails colors={colors}>{details}</BadgeDetails> : null}
    </View>
  );
});
