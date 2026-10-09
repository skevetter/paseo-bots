import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import { appSignIns } from "../../../shared/apps";
import type { ComposerAttachment } from "../../../shared/attachments";
import { capMessageForRender, utf8ByteLength } from "../../../shared/markdown/render-limit";
import { formatDuration, formatMessageTimestamp } from "../../../shared/markdown/timestamps";
import { proposalIdOf } from "../../../shared/proposals";
import {
  buildToolCallPresentation,
  type TaskActivity,
  type TaskEntry,
  type ToolCallDetail,
  type ToolCallStatus,
} from "../../../shared/tools";
import { AttachmentPill } from "../../AttachmentPill";
import { Markdown } from "../../Markdown";
import { CONTENT_MAX_WIDTH, nativeTokens } from "../../native";
import { canSpeak } from "../../speech";
import { content, contentLine, ui } from "../../typography";
import { scrollIntoView } from "../../web";
import { ConnectCard } from "./ConnectCard";
import { ToolCallDetailsContent } from "./details";
import type { StreamRow, TurnFooterInfo } from "./model";
import { PlanCard } from "./PlanCard";
import { ProposalCard } from "./ProposalCard";
import { RoutineRunCard } from "./RoutineRunCard";
import { CopyButton, ExpandableBadge, isWeb, SpeakButton, Spinner } from "./ui";

type Colors = PluginTheme["colors"];
type ImageAttachment = Extract<ComposerAttachment, { kind: "image" }>;

const METADATA_SIZE = 13;
const TIMESTAMP_REVEAL_MS = 3000;

export interface RowContext {
  colors: Colors;
  compact: boolean;
  cwd?: string;
  attachmentsFor(row: Extract<StreamRow, { kind: "user" }>): ComposerAttachment[];
  openChat?(agentId: string): void;
  agentId: string | null;
  /** Set for bots on this host. */
  botId: string | null;
  /** Device voice for reading turns aloud; undefined hides the button. */
  voice?: string | null;
  highlightKey?: string | null;
}

export function RowFrame({
  gapBelow,
  highlight,
  children,
}: {
  gapBelow: number;
  highlight?: string;
  children: ReactNode;
}) {
  const ref = useRef<View>(null);
  useEffect(() => {
    if (highlight) scrollIntoView(ref.current);
  }, [highlight]);
  return (
    <View
      ref={ref}
      style={{
        width: "100%",
        maxWidth: CONTENT_MAX_WIDTH,
        alignSelf: "center",
        paddingHorizontal: 8,
        marginBottom: gapBelow,
        ...(highlight ? { backgroundColor: highlight, borderRadius: 8 } : {}),
      }}
    >
      {children}
    </View>
  );
}

export function RowContent({
  row,
  context,
  compactBottom,
}: {
  row: StreamRow;
  context: RowContext;
  compactBottom: boolean;
}) {
  const { colors } = context;
  switch (row.kind) {
    case "user":
      return (
        <UserMessage
          colors={colors}
          compact={context.compact}
          text={row.text}
          timestamp={row.timestamp}
          attachments={context.attachmentsFor(row)}
        />
      );
    case "assistant":
      return (
        <AssistantMessage colors={colors} text={row.text} phase={row.phase} compactBottom={compactBottom} />
      );
    case "thought":
      return <ThoughtRow colors={colors} compact={context.compact} text={row.text} loading={row.loading} />;
    case "tool": {
      const proposalId = proposalIdOf(row);
      if (proposalId)
        return <ProposalCard colors={colors} compact={context.compact} proposalId={proposalId} />;
      const signIns = appSignIns(row);
      if (signIns.length)
        return (
          <>
            {signIns.map((signIn) => (
              <ConnectCard
                key={signIn.url}
                colors={colors}
                signIn={signIn}
                since={row.timestamp}
                agentId={context.agentId}
                botId={context.botId}
              />
            ))}
          </>
        );
      return (
        <ToolCallRow
          colors={colors}
          compact={context.compact}
          cwd={context.cwd}
          name={row.name}
          status={row.status}
          error={row.error}
          detail={row.detail}
          metadata={row.metadata}
        />
      );
    }
    case "speak":
      return <SpeakMessage colors={colors} text={row.text} />;
    case "todo":
      return <TodoListCard colors={colors} items={row.items} activity={row.activity} />;
    case "notification":
      return <Notification colors={colors} level={row.level} message={row.message} />;
    case "compaction":
      return (
        <CompactionMarker
          colors={colors}
          status={row.status}
          trigger={row.trigger}
          preTokens={row.preTokens}
        />
      );
    case "routine-run":
      return <RoutineRunCard colors={colors} card={row.card} onOpenChat={context.openChat} />;
  }
}

function UserAttachments({
  colors,
  attachments,
  hasText,
  onOpenImage,
}: {
  colors: Colors;
  attachments: ComposerAttachment[];
  hasText: boolean;
  onOpenImage(image: ImageAttachment): void;
}) {
  const images = attachments.filter(
    (attachment): attachment is ImageAttachment => attachment.kind === "image",
  );
  const files = attachments.filter((attachment) => attachment.kind !== "image");
  return (
    <>
      {images.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: hasText || files.length > 0 ? 8 : 0,
          }}
        >
          {images.map((image) => (
            <Pressable
              key={image.id}
              accessibilityRole="button"
              accessibilityLabel="Open image"
              onPress={() => onOpenImage(image)}
            >
              <AttachmentPill colors={colors} attachment={image} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginBottom: hasText ? 8 : 0 }}>
          {files.map((file) => (
            <AttachmentPill key={file.id} colors={colors} attachment={file} />
          ))}
        </View>
      ) : null}
    </>
  );
}

function UserMessageTrailing({
  colors,
  text,
  timestamp,
  visible,
}: {
  colors: Colors;
  text: string;
  timestamp: number;
  visible: boolean;
}) {
  const getText = useCallback(() => text, [text]);
  return (
    <View
      pointerEvents={visible ? "auto" : "none"}
      style={{
        alignSelf: "flex-end",
        flexDirection: "row",
        alignItems: "center",
        height: 24,
        gap: 8,
        marginTop: 8,
        opacity: visible ? 1 : 0,
      }}
    >
      <Text style={{ color: colors.foregroundMuted, fontSize: METADATA_SIZE }}>
        {formatMessageTimestamp(new Date(timestamp))}
      </Text>
      <CopyButton
        colors={colors}
        getContent={getText}
        label="Copy message"
        style={{ alignSelf: "center", marginRight: -4 }}
      />
    </View>
  );
}

const UserMessage = memo(function UserMessage({
  colors,
  compact,
  text,
  timestamp,
  attachments,
}: {
  colors: Colors;
  compact: boolean;
  text: string;
  timestamp: number;
  attachments: ComposerAttachment[];
}) {
  const [hovered, setHovered] = useState(false);
  const [lightbox, setLightbox] = useState<ImageAttachment | null>(null);
  const hasText = text.trim().length > 0;
  const showTrailing = hasText && (compact || !isWeb || hovered);
  return (
    <View
      style={{
        flexDirection: "row",
        justifyContent: "flex-end",
        ...(isWeb ? ({ userSelect: "text" } as object) : {}),
      }}
    >
      {/* On web a Pressable tracks hover for the timestamp row; phones always show it. */}
      <HoverArea onHover={setHovered} style={{ alignItems: "flex-end", maxWidth: "100%", cursor: "auto" }}>
        <View
          style={{
            backgroundColor: nativeTokens(colors).surface3,
            borderRadius: 16,
            borderTopRightRadius: 2,
            paddingHorizontal: 16,
            paddingVertical: 16,
            minWidth: 0,
            flexShrink: 1,
          }}
        >
          <UserAttachments
            colors={colors}
            attachments={attachments}
            hasText={hasText}
            onOpenImage={setLightbox}
          />
          {hasText ? (
            <Text
              selectable
              style={{
                color: colors.foreground,
                fontSize: content(),
                lineHeight: contentLine(),
                ...(isWeb ? ({ overflowWrap: "anywhere" } as object) : {}),
              }}
            >
              {text}
            </Text>
          ) : null}
        </View>
        {hasText ? (
          <UserMessageTrailing colors={colors} text={text} timestamp={timestamp} visible={showTrailing} />
        ) : null}
      </HoverArea>
      {lightbox ? <Lightbox colors={colors} image={lightbox} onClose={() => setLightbox(null)} /> : null}
    </View>
  );
});

function HoverArea({
  onHover,
  style,
  children,
}: {
  onHover(hovered: boolean): void;
  style: object;
  children: ReactNode;
}) {
  if (!isWeb) return <View style={style}>{children}</View>;
  return (
    <Pressable onHoverIn={() => onHover(true)} onHoverOut={() => onHover(false)} style={style}>
      {children}
    </Pressable>
  );
}

function Lightbox({ colors, image, onClose }: { colors: Colors; image: ImageAttachment; onClose(): void }) {
  const uri = `data:${image.mimeType};base64,${image.data}`;
  const [ratio, setRatio] = useState<number | null>(null);
  useEffect(() => {
    Image.getSize(
      uri,
      (width, height) => height > 0 && setRatio(width / height),
      () => setRatio(null),
    );
  }, [uri]);
  return (
    <Modal title={image.name} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>
        <View style={{ backgroundColor: colors.surface0, alignItems: "center", justifyContent: "center" }}>
          <Image
            accessibilityLabel={image.name}
            source={{ uri }}
            resizeMode="contain"
            style={
              ratio ? { width: "100%", aspectRatio: ratio, maxHeight: 720 } : { width: "100%", height: 360 }
            }
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

const AssistantMessage = memo(function AssistantMessage({
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
    () => (capped.capped && phase === "complete" ? utf8ByteLength(text) : null),
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

const SpeakMessage = memo(function SpeakMessage({ colors, text }: { colors: Colors; text: string }) {
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

interface ToolCallRowProps {
  colors: Colors;
  compact: boolean;
  cwd?: string;
  name: string;
  status: ToolCallStatus;
  error: unknown;
  detail: ToolCallDetail;
  metadata?: Record<string, unknown>;
  maxDetailHeight?: number;
}

const ToolCallRow = memo(function ToolCallRow({
  colors,
  compact,
  cwd,
  name,
  status,
  error,
  detail,
  metadata,
  maxDetailHeight = 400,
}: ToolCallRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [sheet, setSheet] = useState(false);
  const presentation = useMemo(
    () => buildToolCallPresentation({ name, status, error: error ?? null, detail, metadata, cwd }),
    [name, status, error, detail, metadata, cwd],
  );
  const toggle = useCallback(() => (compact ? setSheet(true) : setExpanded((value) => !value)), [compact]);
  const renderDetails = useCallback(
    () => (
      <ToolCallDetailsContent
        colors={colors}
        toolName={name}
        detail={detail}
        errorText={presentation.errorText}
        maxHeight={maxDetailHeight}
        showLoadingSkeleton={presentation.isLoadingDetails}
      />
    ),
    [colors, name, detail, presentation.errorText, presentation.isLoadingDetails, maxDetailHeight],
  );

  if (presentation.isPlan && detail.type === "plan")
    return <PlanCard colors={colors} text={detail.text} outcome={presentation.planOutcome} />;

  return (
    <>
      <ExpandableBadge
        colors={colors}
        label={presentation.displayName}
        secondaryLabel={presentation.summary}
        icon={presentation.icon}
        isExpanded={!compact && expanded}
        onToggle={presentation.canOpenDetails ? toggle : undefined}
        renderDetails={presentation.canOpenDetails && !compact ? renderDetails : undefined}
        isLoading={status === "running"}
        isError={status === "failed"}
      />
      {sheet ? (
        <Modal
          title={presentation.displayName}
          icon={<Icon name={presentation.icon} size={20} color={colors.foreground} />}
          open
          onOpenChange={(open) => !open && setSheet(false)}
        >
          <Modal.Content
            style={{ backgroundColor: colors.surface2 }}
            contentContainerStyle={{ padding: 0, gap: 0, flexGrow: 1 }}
          >
            <ToolCallDetailsContent
              colors={colors}
              toolName={name}
              detail={detail}
              errorText={presentation.errorText}
              fillAvailableHeight
              showLoadingSkeleton={presentation.isLoadingDetails}
            />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
});

const ThoughtRow = memo(function ThoughtRow({
  colors,
  compact,
  text,
  loading,
}: {
  colors: Colors;
  compact: boolean;
  text: string;
  loading: boolean;
}) {
  const revealed = useRevealedText(text, loading ? "streaming" : "complete");
  const detail = useMemo<ToolCallDetail>(
    () => ({ type: "unknown", input: revealed, output: null }),
    [revealed],
  );
  return (
    <ToolCallRow
      colors={colors}
      compact={compact}
      name="thinking"
      status={loading ? "running" : "completed"}
      error={null}
      detail={detail}
    />
  );
});

const ACTIVITY_ICONS: Record<TaskActivity["type"], string> = {
  created: "SquareCheck",
  added: "Plus",
  started: "CircleDot",
  completed: "Check",
};
const ACTIVITY_LABELS: Record<Exclude<TaskActivity["type"], "created">, string> = {
  added: "Added",
  started: "Started",
  completed: "Completed",
};

const TodoListCard = memo(function TodoListCard({
  colors,
  items,
  activity,
}: {
  colors: Colors;
  items: TaskEntry[];
  activity: TaskActivity;
}) {
  const [expanded, setExpanded] = useState(false);
  const label =
    activity.type === "created" ? `Created ${activity.count} tasks` : ACTIVITY_LABELS[activity.type];
  const secondary = activity.type === "created" ? undefined : activity.task;
  const renderDetails = useCallback(
    () => (
      <View style={{ padding: 8 }}>
        <View style={{ gap: 4 }}>
          {items.length === 0 ? (
            <Text style={{ color: colors.foregroundMuted, fontSize: ui(14) }}>No tasks yet.</Text>
          ) : (
            items.map((task, index) => (
              <TaskListRow key={task.id ?? `${index}:${task.text}`} colors={colors} task={task} />
            ))
          )}
        </View>
      </View>
    ),
    [colors, items],
  );
  return (
    <ExpandableBadge
      colors={colors}
      label={label}
      secondaryLabel={secondary}
      icon={ACTIVITY_ICONS[activity.type]}
      isExpanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      renderDetails={renderDetails}
    />
  );
});

const TASK_ICONS = { completed: "CircleCheck", running: "CircleDot", pending: "Circle" } as const;

function taskState(task: TaskEntry): keyof typeof TASK_ICONS {
  if (task.completed || task.status === "completed") return "completed";
  return task.status === "in_progress" ? "running" : "pending";
}

function TaskListRow({ colors, task }: { colors: Colors; task: TaskEntry }) {
  const tokens = nativeTokens(colors);
  const state = taskState(task);
  const completed = state === "completed";
  const running = state === "running";
  const text = running && task.activeForm ? task.activeForm : task.text;
  const textColors = {
    completed: tokens.foregroundExtraMuted,
    running: colors.foreground,
    pending: colors.foregroundMuted,
  };
  return (
    <View accessibilityLabel={text} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Icon
        name={TASK_ICONS[state]}
        size={16}
        color={running ? tokens.statusDotRunning : tokens.foregroundExtraMuted}
      />
      <Text
        numberOfLines={1}
        style={{
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
          fontSize: ui(14),
          color: textColors[state],
          ...(completed ? { textDecorationLine: "line-through" as const } : {}),
        }}
      >
        {text}
      </Text>
    </View>
  );
}

const NOTIFICATION_STYLES = {
  info: { background: "rgba(147, 197, 253, 0.1)", icon: "Info", tint: "#93c5fd" },
  warning: { background: "rgba(245, 158, 11, 0.1)", icon: "TriangleAlert", tint: "#f59e0b" },
  error: { background: "rgba(239, 68, 68, 0.1)", icon: "CircleX", tint: "" },
} as const;

const Notification = memo(function Notification({
  colors,
  level,
  message,
}: {
  colors: Colors;
  level: "info" | "warning" | "error";
  message: string;
}) {
  const style = NOTIFICATION_STYLES[level];
  return (
    <View style={{ borderRadius: 6, overflow: "hidden", backgroundColor: style.background }}>
      <View style={{ paddingHorizontal: 12, paddingVertical: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8 }}>
          <View style={{ flexShrink: 0, height: 20, justifyContent: "center" }}>
            <Icon name={style.icon} size={16} color={style.tint || colors.statusDanger} />
          </View>
          <View style={{ flex: 1 }}>
            <Text selectable style={{ color: colors.foreground, fontSize: ui(14), lineHeight: 20 }}>
              {message}
            </Text>
          </View>
        </View>
      </View>
    </View>
  );
});

function compactionLabel(
  status: "loading" | "completed",
  trigger?: "auto" | "manual",
  preTokens?: number,
): string {
  if (status === "loading") return "Compacting...";
  if (trigger === "auto") return "Context automatically compacted";
  if (trigger === "manual") return "Context manually compacted";
  if (preTokens) return `Context compacted (${Math.round(preTokens / 1000)}K tokens)`;
  return "Context compacted";
}

const CompactionMarker = memo(function CompactionMarker({
  colors,
  status,
  trigger,
  preTokens,
}: {
  colors: Colors;
  status: "loading" | "completed";
  trigger?: "auto" | "manual";
  preTokens?: number;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingVertical: 12,
        paddingHorizontal: 16,
        gap: 8,
      }}
    >
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        {status === "loading" ? (
          <Spinner color="#a1a1aa" />
        ) : (
          <Icon name="Scissors" size={12} color="#a1a1aa" />
        )}
        <Text style={{ fontSize: METADATA_SIZE, color: colors.foregroundMuted }}>
          {compactionLabel(status, trigger, preTokens)}
        </Text>
      </View>
      <View style={{ flex: 1, height: 1, backgroundColor: colors.border }} />
    </View>
  );
});

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
        <CopyButton colors={colors} getContent={getContent} style={{ alignSelf: "center", marginLeft: -4 }} />
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
