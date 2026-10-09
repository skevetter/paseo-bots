import type { PluginTheme } from "@getpaseo/plugin";
import { memo, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { formatDuration, formatMessageTimestamp } from "../../../shared/markdown/timestamps";
import { CONTENT_MAX_WIDTH } from "../../native";
import { canSpeak } from "../../speech";
import { CopyButton, SpeakButton } from "./buttons";
import type { TurnFooterInfo } from "./model";
import { isWeb, METADATA_SIZE, Spinner } from "./ui";

type Colors = PluginTheme["colors"];

const TIMESTAMP_REVEAL_MS = 3000;

function TurnFooterRow({ children }: { children: ReactNode }) {
  return (
    <View
      style={{
        width: "100%",
        maxWidth: CONTENT_MAX_WIDTH,
        alignSelf: "center",
        paddingHorizontal: 8,
        marginTop: 13,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          alignSelf: "flex-start",
          minHeight: 24,
          paddingBottom: 32,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function useTimestampReveal(canSwap: boolean) {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = () => {
    if (isWeb || !canSwap) return;
    clearTimeout(timer.current);
    setRevealed((value) => !value);
    timer.current = setTimeout(() => {
      setRevealed(false);
      timer.current = undefined;
    }, TIMESTAMP_REVEAL_MS);
  };
  return { revealed, press };
}

function turnTimeLabels(footer: TurnFooterInfo) {
  const durationLabel = footer.durationMs !== null ? `Worked for ${formatDuration(footer.durationMs)}` : "";
  const timestampLabel =
    footer.completedAt !== null ? formatMessageTimestamp(new Date(footer.completedAt)) : "";
  return { durationLabel, timestampLabel };
}

function TurnTimeLabel({ colors, footer }: { colors: Colors; footer: TurnFooterInfo }) {
  const [hovered, setHovered] = useState(false);
  const { durationLabel, timestampLabel } = turnTimeLabels(footer);
  const primary = durationLabel || timestampLabel;
  const canSwap = Boolean(durationLabel && timestampLabel);
  const { revealed, press } = useTimestampReveal(canSwap);
  const showTimestamp = canSwap && (isWeb ? hovered : revealed);
  const labelStyle = { color: colors.foregroundMuted, fontSize: METADATA_SIZE };
  if (!primary) return null;
  return (
    <Pressable
      onPress={press}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      accessibilityRole={canSwap ? "button" : undefined}
      accessibilityLabel={canSwap ? `${durationLabel}, ended ${timestampLabel}` : primary}
    >
      <View style={{ position: "relative" }}>
        {/* Sizer keeps the width stable while the labels swap. */}
        <Text aria-hidden style={[labelStyle, { opacity: 0 }]}>
          {primary.length >= timestampLabel.length ? primary : timestampLabel}
        </Text>
        <Text style={[labelStyle, { position: "absolute", top: 0, left: 0 }]}>
          {showTimestamp ? timestampLabel : primary}
        </Text>
      </View>
    </Pressable>
  );
}

export const CompletedTurnFooter = memo(function CompletedTurnFooter({
  colors,
  footer,
  voice,
}: {
  colors: Colors;
  footer: TurnFooterInfo;
  voice?: string | null;
}) {
  const getContent = useCallback(() => footer.copy, [footer.copy]);
  return (
    <TurnFooterRow>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <CopyButton
          colors={colors}
          getContent={getContent}
          label="Copy turn"
          style={{ alignSelf: "center", marginLeft: -4 }}
        />
        {canSpeak && voice !== undefined && footer.copy ? (
          <SpeakButton colors={colors} text={footer.copy} voice={voice} />
        ) : null}
        <TurnTimeLabel colors={colors} footer={footer} />
      </View>
    </TurnFooterRow>
  );
});

export function WorkingIndicator({
  colors,
  startedAt,
}: {
  colors: Colors;
  startedAt: string | null | undefined;
}) {
  const started = startedAt ? Date.parse(startedAt) : NaN;
  return (
    <TurnFooterRow>
      <View
        style={{
          height: 24,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "flex-start",
          gap: 12,
        }}
      >
        <View style={{ marginLeft: -2 }}>
          <Spinner color={colors.foreground} size={14} />
        </View>
        {Number.isFinite(started) ? <LiveElapsed colors={colors} startedAt={started} /> : null}
      </View>
    </TurnFooterRow>
  );
}

function LiveElapsed({ colors, startedAt }: { colors: Colors; startedAt: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - startedAt));
  useEffect(() => {
    const tick = () => setElapsed(Math.max(0, Date.now() - startedAt));
    tick();
    const handle = setInterval(tick, 1000);
    return () => clearInterval(handle);
  }, [startedAt]);
  return (
    <Text style={{ color: colors.foregroundMuted, fontSize: METADATA_SIZE, fontVariant: ["tabular-nums"] }}>
      {formatDuration(elapsed)}
    </Text>
  );
}
