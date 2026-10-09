import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { memo, useMemo } from "react";
import { Text, View } from "react-native";
import { utf8Bytes } from "../../../shared/bot-checks";
import { capMessageForRender } from "../../../shared/markdown/render-limit";
import { Markdown } from "../../Markdown";
import { content, ui } from "../../typography";
import { isWeb } from "./ui";

type Colors = PluginTheme["colors"];

export const AssistantMessage = memo(function AssistantMessage({
  colors,
  text,
  phase,
  compactBottom,
}: {
  colors: Colors;
  text: string;
  phase: "streaming" | "complete";
  compactBottom: boolean;
}) {
  const capped = useMemo(() => capMessageForRender(text), [text]);
  const revealed = useRevealedText(capped.text, phase);
  const bytes = useMemo(
    () => (capped.capped && phase === "complete" ? utf8Bytes(text) : null),
    [capped.capped, phase, text],
  );
  return (
    <View
      style={{
        paddingTop: 12,
        paddingBottom: compactBottom ? 0 : 12,
        ...(isWeb ? ({ userSelect: "text" } as object) : {}),
      }}
    >
      <Markdown colors={colors} text={revealed} streaming={phase === "streaming"} />
      {bytes !== null ? (
        <Text style={{ marginTop: 12, fontSize: ui(14), fontStyle: "italic", color: colors.foregroundMuted }}>
          This message was capped ({bytes} bytes).
        </Text>
      ) : null}
    </View>
  );
});

export const SpeakMessage = memo(function SpeakMessage({ colors, text }: { colors: Colors; text: string }) {
  return (
    <View style={{ paddingVertical: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <Icon name="MicVocal" size={12} color={colors.foregroundMuted} />
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>Spoke</Text>
      </View>
      <Text
        selectable
        style={{ fontSize: content(), lineHeight: Math.round(content() * 1.4), color: colors.foreground }}
      >
        {text}
      </Text>
    </View>
  );
});
