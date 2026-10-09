import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal, useRevealedText } from "@getpaseo/plugin/client/react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { buildToolCallPresentation, type ToolCallDetail, type ToolCallStatus } from "../../../shared/tools";
import { ToolCallDetailsContent } from "./details";
import { ExpandableBadge } from "./ExpandableBadge";
import { PlanCard } from "./PlanCard";

type Colors = PluginTheme["colors"];

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

export const ToolCallRow = memo(function ToolCallRow({
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

export const ThoughtRow = memo(function ThoughtRow({
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
