import type { PluginTheme } from "@getpaseo/plugin";
import { type ReactNode, useEffect, useRef } from "react";
import { View } from "react-native";
import { appSignIns } from "../../../shared/apps";
import type { ComposerAttachment } from "../../../shared/attachments";
import { proposalIdOf } from "../../../shared/proposals";
import { CONTENT_MAX_WIDTH } from "../../native";
import { scrollIntoView } from "../../web";
import { AssistantMessage, SpeakMessage } from "./AssistantMessage";
import { ConnectCard } from "./ConnectCard";
import type { StreamRow } from "./model";
import { CompactionMarker, Notification } from "./notices";
import { ProposalCard } from "./ProposalCard";
import { RoutineRunCard } from "./RoutineRunCard";
import { TodoListCard } from "./TodoListCard";
import { ThoughtRow, ToolCallRow } from "./ToolCallRow";
import { UserMessage } from "./UserMessage";

type Colors = PluginTheme["colors"];

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
