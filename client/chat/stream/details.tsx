import type { PluginTheme } from "@getpaseo/plugin";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactNode, useMemo } from "react";
import { Text, type TextStyle, View, type ViewStyle } from "react-native";
import {
  buildLineDiff,
  type DiffLine,
  type DiffSegment,
  hasMeaningfulToolCallDetail,
  parseUnifiedDiff,
  type ToolCallDetail,
} from "../../../shared/tools";
import { MONO_FONT, MONO_PROPS, nativeTokens } from "../../native";
import { code, ui } from "../../typography";
import { isWeb, keysWithOccurrence } from "./ui";

type Colors = PluginTheme["colors"];

// Paseo's ToolCallDetailsContent (components/tool-call-details.tsx) and its
// DiffViewer. Code insets: padding 12, extra right 16, extra bottom 12.
const PAD = 12;
const EXTRA_RIGHT = 16;
const EXTRA_BOTTOM = 12;
const CODE_LINE = 18;

interface Props {
  colors: Colors;
  toolName?: string;
  detail?: ToolCallDetail;
  errorText?: string;
  maxHeight?: number;
  /** In the phone sheet: grow to the sheet's height instead of capping. */
  fillAvailableHeight?: boolean;
  showLoadingSkeleton?: boolean;
}

interface Styles {
  mono: TextStyle;
  scrollArea: ViewStyle;
  maxHeight: number | undefined;
  fill: boolean;
}

function monoText(colors: Colors): TextStyle {
  return {
    fontFamily: MONO_FONT,
    fontSize: code(),
    color: colors.foreground,
    lineHeight: CODE_LINE,
    ...(isWeb ? ({ whiteSpace: "pre", overflowWrap: "normal" } as TextStyle) : {}),
  };
}

function buildStyles({
  colors,
  detail,
  maxHeight,
  fillAvailableHeight,
}: {
  colors: Colors;
  detail: ToolCallDetail | undefined;
  maxHeight: number | undefined;
  fillAvailableHeight: boolean;
}): Styles {
  const resolvedMax = fillAvailableHeight ? undefined : (maxHeight ?? 300);
  const fill =
    fillAvailableHeight && ["shell", "edit", "write", "read", "sub_agent"].includes(detail?.type ?? "");
  return {
    mono: monoText(colors),
    scrollArea: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 4,
      backgroundColor: colors.surface2,
      ...(resolvedMax !== undefined ? { maxHeight: resolvedMax } : {}),
      ...(fill ? { flex: 1, minHeight: 0 } : {}),
    },
    maxHeight: resolvedMax,
    fill,
  };
}

export const ToolCallDetailsContent = memo(function ToolCallDetailsContent({
  colors,
  toolName,
  detail,
  errorText,
  maxHeight,
  fillAvailableHeight = false,
  showLoadingSkeleton = false,
}: Props) {
  const fullBleed = detail?.type === "edit" || detail?.type === "shell" || detail?.type === "write";
  const styles = buildStyles({ colors, detail, maxHeight, fillAvailableHeight });
  const sections = buildSections(colors, toolName, detail, styles);
  if (errorText) sections.push(<ErrorSection key="error" colors={colors} text={errorText} styles={styles} />);
  if (sections.length === 0)
    return <EmptyDetails colors={colors} showLoadingSkeleton={showLoadingSkeleton} />;
  return (
    <View style={{ gap: fullBleed ? 8 : 16, padding: 0, ...(styles.fill ? { flex: 1, minHeight: 0 } : {}) }}>
      {sections}
    </View>
  );
});

function EmptyDetails({ colors, showLoadingSkeleton }: { colors: Colors; showLoadingSkeleton: boolean }) {
  if (showLoadingSkeleton) return <LoadingSkeleton colors={colors} />;
  return (
    <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), fontStyle: "italic" }}>
      No additional details available
    </Text>
  );
}

/** A full-bleed code surface (shell, edit, sub-agent): surface1, scrolls both ways. */
function CodeSurface({ colors, styles, children }: { colors: Colors; styles: Styles; children: ReactNode }) {
  return (
    <View
      style={{
        backgroundColor: colors.surface1,
        overflow: "hidden",
        ...(styles.fill ? { flex: 1, minHeight: 0 } : {}),
      }}
    >
      <ScrollView
        style={
          styles.maxHeight !== undefined
            ? { maxHeight: styles.maxHeight }
            : styles.fill
              ? { flex: 1 }
              : undefined
        }
        contentContainerStyle={{ flexGrow: 1, paddingBottom: EXTRA_BOTTOM }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          contentContainerStyle={{ paddingRight: EXTRA_RIGHT }}
        >
          <View style={{ minWidth: "100%", padding: PAD }}>{children}</View>
        </ScrollView>
      </ScrollView>
    </View>
  );
}

/** A bordered surface2 box of monospace text (read, write, fetch, search output). */
function ScrollableText({
  colors,
  text,
  styles,
  startLine,
}: {
  colors: Colors;
  text: string;
  styles: Styles;
  startLine?: number;
}) {
  return (
    <ScrollView
      style={styles.scrollArea}
      contentContainerStyle={{ padding: PAD }}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        {startLine !== undefined ? (
          <NumberedLines colors={colors} text={text} styles={styles} startLine={startLine} />
        ) : (
          <Text selectable {...MONO_PROPS} style={styles.mono}>
            {text}
          </Text>
        )}
      </ScrollView>
    </ScrollView>
  );
}

function NumberedLines({
  colors,
  text,
  styles,
  startLine,
}: {
  colors: Colors;
  text: string;
  styles: Styles;
  startLine: number;
}) {
  const rows = useMemo(
    () =>
      text
        .replace(/\n$/, "")
        .split("\n")
        .map((line, index) => ({ number: startLine + index, line })),
    [text, startLine],
  );
  const gutter = Math.max(2, String(startLine + rows.length - 1).length) * Math.ceil(code() * 0.62) + 12;
  return (
    <View>
      {rows.map((row) => (
        <View key={row.number} style={{ flexDirection: "row", minHeight: CODE_LINE }}>
          <Text
            {...MONO_PROPS}
            style={[
              styles.mono,
              {
                width: gutter,
                color: colors.foregroundMuted,
                opacity: 0.6,
                flexShrink: 0,
                ...(isWeb ? ({ userSelect: "none" } as TextStyle) : {}),
              },
            ]}
          >
            {row.number}
          </Text>
          <Text selectable {...MONO_PROPS} style={styles.mono}>
            {row.line}
          </Text>
        </View>
      ))}
    </View>
  );
}

function PlainTextSection({ colors, text, styles }: { colors: Colors; text: string; styles: Styles }) {
  return (
    <View style={{ gap: 8 }}>
      <ScrollView
        style={{ ...styles.scrollArea, flex: undefined }}
        contentContainerStyle={{ padding: PAD }}
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <Text
          selectable
          style={{
            fontSize: ui(14),
            lineHeight: 22,
            color: colors.foreground,
            ...(isWeb ? ({ overflowWrap: "anywhere" } as TextStyle) : {}),
          }}
        >
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

function DiffView({ colors, lines, styles }: { colors: Colors; lines: DiffLine[]; styles: Styles }) {
  const lineStyle = (line: DiffLine): { box: ViewStyle; text: TextStyle } => {
    switch (line.type) {
      case "add":
        return { box: { backgroundColor: "rgba(46, 160, 67, 0.15)" }, text: { color: colors.foreground } };
      case "remove":
        return { box: { backgroundColor: "rgba(248, 81, 73, 0.1)" }, text: { color: colors.foreground } };
      case "header":
        return { box: { backgroundColor: colors.surface1 }, text: { color: colors.foregroundMuted } };
      default:
        return { box: { backgroundColor: colors.surface1 }, text: { color: colors.foregroundMuted } };
    }
  };
  if (lines.length === 0) return null;
  const keys = keysWithOccurrence(lines.map((line) => line.content));
  return (
    <ScrollView
      style={
        styles.maxHeight !== undefined
          ? { maxHeight: styles.maxHeight }
          : styles.fill
            ? { flex: 1 }
            : undefined
      }
      contentContainerStyle={{ flexGrow: 1, paddingBottom: EXTRA_BOTTOM }}
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        contentContainerStyle={{ flexDirection: "column", paddingRight: EXTRA_RIGHT }}
      >
        <View style={{ alignSelf: "flex-start", padding: PAD }}>
          {lines.map((line, index) => {
            const style = lineStyle(line);
            const highlight = line.type === "add" ? "rgba(46, 160, 67, 0.4)" : "rgba(248, 81, 73, 0.35)";
            return (
              <View key={keys[index]} style={[{ minWidth: "100%", paddingVertical: 4 }, style.box]}>
                <Text selectable {...MONO_PROPS} style={[styles.mono, style.text]}>
                  {line.segments
                    ? [line.content[0], ...renderSegments(line.segments, highlight)]
                    : line.content}
                </Text>
              </View>
            );
          })}
        </View>
      </ScrollView>
    </ScrollView>
  );
}

function renderSegments(segments: DiffSegment[], highlight: string): ReactNode[] {
  const keys = keysWithOccurrence(segments.map((segment) => segment.text));
  return segments.map((segment, part) => (
    <Text key={keys[part]} style={segment.changed ? { backgroundColor: highlight } : undefined}>
      {segment.text}
    </Text>
  ));
}

function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type DetailOf<T extends ToolCallDetail["type"]> = Extract<ToolCallDetail, { type: T }>;

function shellSections(colors: Colors, detail: DetailOf<"shell">, styles: Styles): ReactNode[] {
  const command = detail.command.replace(/\n+$/, "");
  const output = (detail.output ?? "").replace(/^\n+/, "");
  return [
    <CodeSurface key="shell" colors={colors} styles={styles}>
      <Text selectable {...MONO_PROPS} style={styles.mono}>
        <Text style={{ color: colors.foregroundMuted }}>$ </Text>
        {command}
        {output ? `\n\n${output}` : ""}
      </Text>
    </CodeSurface>,
  ];
}

function worktreeSections(colors: Colors, detail: DetailOf<"worktree_setup">, styles: Styles): ReactNode[] {
  const log = detail.log.replace(/^\n+/, "");
  return [
    <CodeSurface key="worktree" colors={colors} styles={styles}>
      <Text selectable {...MONO_PROPS} style={styles.mono}>
        {log || `Preparing worktree ${detail.branchName} at ${detail.worktreePath}`}
      </Text>
    </CodeSurface>,
  ];
}

function editSections(colors: Colors, detail: DetailOf<"edit">, styles: Styles): ReactNode[] {
  const lines = detail.unifiedDiff
    ? parseUnifiedDiff(detail.unifiedDiff)
    : buildLineDiff(detail.oldString ?? "", detail.newString ?? "");
  return [
    <View
      key="edit"
      style={{
        backgroundColor: colors.surface1,
        overflow: "hidden",
        ...(styles.fill ? { flex: 1, minHeight: 0 } : {}),
      }}
    >
      <DiffView colors={colors} lines={lines} styles={styles} />
    </View>,
  ];
}

function searchSections(colors: Colors, detail: DetailOf<"search">, styles: Styles): ReactNode[] {
  const out: ReactNode[] = [];
  if (detail.content)
    out.push(
      <ScrollableText
        key="content"
        colors={colors}
        text={detail.content}
        styles={{ ...styles, scrollArea: { ...styles.scrollArea, flex: undefined } }}
      />,
    );
  const lists: [string, string | undefined][] = [
    ["files", detail.filePaths?.length ? detail.filePaths.join("\n") : undefined],
    [
      "web",
      detail.webResults?.length
        ? detail.webResults.map((entry) => `${entry.title}\n${entry.url}`).join("\n\n")
        : undefined,
    ],
    ["annotations", detail.annotations?.length ? detail.annotations.join("\n\n") : undefined],
  ];
  for (const [key, text] of lists) {
    if (!text) continue;
    out.push(
      <View key={key} style={{ gap: 8 }}>
        <Text selectable {...MONO_PROPS} style={styles.mono}>
          {text}
        </Text>
      </View>,
    );
  }
  return out;
}

function unknownSections(colors: Colors, detail: DetailOf<"unknown">, styles: Styles): ReactNode[] {
  if (typeof detail.input === "string" && detail.output === null)
    return [<PlainTextSection key="plain" colors={colors} text={detail.input} styles={styles} />];
  const out: ReactNode[] = [];
  for (const [title, value] of [
    ["Input", detail.input],
    ["Output", detail.output],
  ] as const) {
    if (!hasMeaningfulToolCallDetail({ type: "unknown", input: value ?? null, output: null })) continue;
    const text = stringify(value);
    if (!text.length) continue;
    out.push(
      <View
        key={`${title}-header`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: colors.border,
        }}
      >
        <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>{title}</Text>
      </View>,
      <View key={`${title}-value`} style={{ gap: 8 }}>
        <ScrollView
          horizontal
          nestedScrollEnabled
          showsHorizontalScrollIndicator
          style={{
            borderWidth: 1,
            borderColor: colors.border,
            borderRadius: 4,
            backgroundColor: colors.surface2,
          }}
          contentContainerStyle={{ padding: PAD }}
        >
          <Text selectable {...MONO_PROPS} style={styles.mono}>
            {text}
          </Text>
        </ScrollView>
      </View>,
    );
  }
  return out;
}

function readSections(colors: Colors, detail: DetailOf<"read">, styles: Styles): ReactNode[] {
  if (!detail.content) return [];
  return [
    <ScrollableText
      key="read"
      colors={colors}
      text={detail.content}
      styles={styles}
      startLine={detail.offset ?? 1}
    />,
  ];
}

function buildSections(
  colors: Colors,
  _toolName: string | undefined,
  detail: ToolCallDetail | undefined,
  styles: Styles,
): ReactNode[] {
  if (!detail) return [];
  switch (detail.type) {
    case "shell":
      return shellSections(colors, detail, styles);
    case "worktree_setup":
      return worktreeSections(colors, detail, styles);
    case "sub_agent":
      return [<SubAgentSection key="sub-agent" colors={colors} detail={detail} styles={styles} />];
    case "edit":
      return editSections(colors, detail, styles);
    case "write":
      return detail.content
        ? [<ScrollableText key="write" colors={colors} text={detail.content} styles={styles} />]
        : [];
    case "read":
      return readSections(colors, detail, styles);
    case "search":
      return searchSections(colors, detail, styles);
    case "fetch":
      return [
        <ScrollableText
          key="fetch"
          colors={colors}
          text={detail.result ? `${detail.url}\n\n${detail.result}` : detail.url}
          styles={styles}
        />,
      ];
    case "plain_text":
      return detail.text
        ? [<PlainTextSection key="plain" colors={colors} text={detail.text} styles={styles} />]
        : [];
    case "unknown":
      return unknownSections(colors, detail, styles);
    default:
      return [];
  }
}

interface SubAgentAction {
  index: number;
  tool: string;
  summary?: string;
}

function parseSubAgentAction(line: string): Omit<SubAgentAction, "index"> | null {
  const match = /^\[([^\]]+)\](?:\s+(.*))?$/.exec(line);
  const tool = match?.[1]?.trim();
  if (!tool) return null;
  const summary = match?.[2]?.trim();
  return summary ? { tool, summary } : { tool };
}

function parseSubAgentLog(log: string): { actions: SubAgentAction[]; log: string } {
  const actions: SubAgentAction[] = [];
  const rest: string[] = [];
  for (const line of log.replace(/^\n+/, "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const action = parseSubAgentAction(trimmed);
    if (action) actions.push({ index: actions.length + 1, ...action });
    else rest.push(line);
  }
  return { actions, log: rest.join("\n").replace(/^\n+/, "") };
}

function formatToolName(name: string): string {
  return name
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function SubAgentSection({
  colors,
  detail,
  styles,
}: {
  colors: Colors;
  detail: Extract<ToolCallDetail, { type: "sub_agent" }>;
  styles: Styles;
}) {
  const parsed = useMemo(() => parseSubAgentLog(detail.log), [detail.log]);
  const header =
    detail.subAgentType && detail.description
      ? `${detail.subAgentType}: ${detail.description}`
      : (detail.subAgentType ?? detail.description ?? "Sub-agent activity");
  return (
    <CodeSurface colors={colors} styles={styles}>
      {detail.childSessionId ? (
        <Text
          selectable
          {...MONO_PROPS}
          style={[styles.mono, { color: colors.foregroundMuted, marginBottom: 8 }]}
        >
          session {detail.childSessionId}
        </Text>
      ) : null}
      {parsed.actions.length > 0 ? (
        <View style={{ gap: 4, marginBottom: 8 }}>
          {parsed.actions.map((action) => (
            <View key={action.index} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <Text selectable {...MONO_PROPS} style={[styles.mono, { color: colors.foregroundMuted }]}>
                {formatToolName(action.tool)}
              </Text>
              {action.summary ? (
                <Text selectable {...MONO_PROPS} style={styles.mono}>
                  {action.summary}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}
      {parsed.log || parsed.actions.length === 0 ? (
        <Text selectable {...MONO_PROPS} style={styles.mono}>
          {parsed.log || header}
        </Text>
      ) : null}
    </CodeSurface>
  );
}

function ErrorSection({ colors, text, styles }: { colors: Colors; text: string; styles: Styles }) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        style={{
          color: colors.statusDanger,
          fontSize: ui(12),
          fontWeight: "600",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        Error
      </Text>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator
        style={{
          borderWidth: 1,
          borderColor: colors.statusDanger,
          borderRadius: 4,
          backgroundColor: colors.surface2,
        }}
        contentContainerStyle={{ padding: PAD }}
      >
        <Text selectable {...MONO_PROPS} style={[styles.mono, { color: colors.statusDanger }]}>
          {text}
        </Text>
      </ScrollView>
    </View>
  );
}

function LoadingSkeleton({ colors }: { colors: Colors }) {
  const bar = (width: `${number}%`) => (
    <View style={{ height: 12, width, borderRadius: 9999, backgroundColor: nativeTokens(colors).surface3 }} />
  );
  return (
    <View style={{ gap: 8, padding: 12 }}>
      {bar("100%")}
      {bar("72%")}
      {bar("48%")}
    </View>
  );
}
