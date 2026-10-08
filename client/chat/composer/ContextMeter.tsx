import type { PluginTheme } from "@getpaseo/plugin";
import { useRef } from "react";
import { Pressable, View } from "react-native";
import { nativeTokens } from "../../native";
import { measureAnchor, useMenu } from "../../ui/Menu";
import { tooltip, tooltipsShown } from "../../ui/Tooltip";
import { type ContextUsage, formatSessionCost, formatTokenCount, meterTone, ringRotations } from "./logic";

type Colors = PluginTheme["colors"];

const AMBER_500 = "#f59e0b";

export function ContextMeter({
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
  const tokens = nativeTokens(colors);
  const menu = useMenu();
  const anchor = useRef<View>(null);
  if (!usage) {
    if (!pending) return null;
    return (
      <View style={{ width: 28, height: 28, alignItems: "center", justifyContent: "center" }}>
        <Ring size={glyphSize} stroke={2} percent={0} track={tokens.surface3} progress={tokens.surface3} />
      </View>
    );
  }
  const rounded = Math.round(usage.percent);
  const tone = meterTone(usage.percent);
  const progress =
    tone === "danger" ? colors.statusDanger : tone === "warning" ? AMBER_500 : colors.foregroundMuted;
  const cost = usage.costUsd !== null ? formatSessionCost(usage.costUsd) : null;
  const tokensLine = `${formatTokenCount(usage.used)} / ${formatTokenCount(usage.max)} tokens`;
  const costLine = cost ? `Session cost ${cost}` : null;
  const open = async () => {
    if (tooltipsShown()) return;
    const rect = await measureAnchor(anchor);
    if (!rect) return;
    const noop = () => {};
    menu.open({
      anchor: rect,
      align: "end",
      width: 220,
      title: "Context window",
      entries: [
        { label: `${rounded}% used`, onSelect: noop },
        { label: tokensLine, onSelect: noop },
        ...(costLine ? [{ label: costLine, onSelect: noop }] : []),
      ],
    });
  };
  return (
    <Pressable
      ref={anchor}
      accessibilityRole="button"
      accessibilityLabel={`Context window ${rounded}% used`}
      {...tooltip("Context window", "top", {
        lines: [`${rounded}% used`],
        details: costLine ? [tokensLine, costLine] : [tokensLine],
        delay: 0,
      })}
      onPress={() => void open()}
      style={{ width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center" }}
    >
      <Ring size={glyphSize} stroke={2} percent={usage.percent} track={tokens.surface3} progress={progress} />
    </Pressable>
  );
}

function Ring({
  size,
  stroke,
  percent,
  track,
  progress,
}: {
  size: number;
  stroke: number;
  percent: number;
  track: string;
  progress: string;
}) {
  const half = size / 2;
  const { right, left } = ringRotations(percent);
  const arc = (rotation: number, offset: number) => ({
    position: "absolute" as const,
    top: 0,
    left: offset,
    width: size,
    height: size,
    borderRadius: half,
    borderWidth: stroke,
    borderTopColor: progress,
    borderRightColor: progress,
    borderBottomColor: "transparent",
    borderLeftColor: "transparent",
    transform: [{ rotate: `${rotation}deg` }],
  });
  return (
    <View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size }}
    >
      <View
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: size,
          height: size,
          borderRadius: half,
          borderWidth: stroke,
          borderColor: track,
        }}
      />
      {percent > 0 ? (
        <View
          style={{ position: "absolute", top: 0, left: half, width: half, height: size, overflow: "hidden" }}
        >
          <View style={arc(right, -half)} />
        </View>
      ) : null}
      {left !== null ? (
        <View
          style={{ position: "absolute", top: 0, left: 0, width: half, height: size, overflow: "hidden" }}
        >
          <View style={arc(left, 0)} />
        </View>
      ) : null}
    </View>
  );
}
