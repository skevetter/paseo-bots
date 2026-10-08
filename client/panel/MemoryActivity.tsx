import { useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { dayName, journalSource, journalSummary } from "../../shared/activity";
import type { Bot } from "../../shared/bot";
import {
  type JournalRow,
  memoryJournalRpc,
  memoryLogDeleteRpc,
  memoryLogRpc,
  memoryUndoRpc,
} from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { ToolCallDetailsContent } from "../chat/stream/details";
import { confirmDialog, errorText, MONO_FONT, MONO_PROPS } from "../native";
import { code, codeLine, ui } from "../typography";
import type { PanelProps } from "./BotPanel";
import { Button, CardNote, DrillRow, SheetActions } from "./controls";

type Colors = PanelProps["colors"];

const SHOWN = 20;
const DAYS = 14;
const journalKey = (botId: string) => ["paseo-bots", "memory-journal", botId];
const logKey = (botId: string) => ["paseo-bots", "memory-log", botId];

export function useMemoryJournal(botId: string) {
  const journal = useRpc(memoryJournalRpc);
  return useQuery({
    queryKey: journalKey(botId),
    queryFn: () => journal({ botId }),
    refetchInterval: 20_000,
  });
}

export function useDailyLog(botId: string) {
  const log = useRpc(memoryLogRpc);
  return useQuery({ queryKey: logKey(botId), queryFn: () => log({ botId }), refetchInterval: 30_000 });
}

export function ChangesSheet({
  colors,
  bot,
  onUndone,
  onClose,
}: {
  colors: Colors;
  bot: Bot;
  onUndone(): void;
  onClose(): void;
}) {
  const query = useMemoryJournal(bot.id);
  const undo = useRpc(memoryUndoRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState<JournalRow | null>(null);
  const [busy, setBusy] = useState(false);
  const rows = (query.data?.entries ?? []).slice(0, SHOWN);

  const revert = async (row: JournalRow) => {
    setBusy(true);
    try {
      await undo({ botId: bot.id, id: row.id });
      await queryClient.invalidateQueries({ queryKey: journalKey(bot.id) });
      onUndone();
      setOpen(null);
    } catch (error) {
      toast.error(`Couldn't undo: ${errorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const locked = open !== null && busy;
  return (
    <Modal
      title={open ? journalSummary(open, bot.name) : "Memory changes"}
      open
      onOpenChange={(value) => !value && !locked && onClose()}
    >
      <Modal.Content>
        {open ? (
          <ChangeDetail
            colors={colors}
            row={open}
            busy={busy}
            actions={{ onBack: () => setOpen(null), onUndo: () => void revert(open) }}
          />
        ) : (
          <ChangeList colors={colors} bot={bot} rows={rows} loading={query.isLoading} onOpen={setOpen} />
        )}
      </Modal.Content>
    </Modal>
  );
}

function ChangeList({
  colors,
  bot,
  rows,
  loading,
  onOpen,
}: {
  colors: Colors;
  bot: Bot;
  rows: readonly JournalRow[];
  loading: boolean;
  onOpen(row: JournalRow): void;
}) {
  return (
    <>
      <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
        Every change to the memory files, by the bot or by you. Undo puts a file back the way it was before
        that change.
      </Text>
      <SettingsCard>
        {rows.length === 0 ? (
          <CardNote colors={colors} text={loading ? "Loading..." : "No changes yet"} loading={loading} />
        ) : null}
        {rows.map((row) => (
          <DrillRow
            key={row.id}
            colors={colors}
            label={journalSummary(row, bot.name)}
            hint={`${relativeTime(row.at)} · ${journalSource(row)}`}
            onPress={() => onOpen(row)}
          />
        ))}
      </SettingsCard>
    </>
  );
}

function ChangeDetail({
  colors,
  row,
  busy,
  actions,
}: {
  colors: Colors;
  row: JournalRow;
  busy: boolean;
  actions: { onBack(): void; onUndo(): void };
}) {
  const file = row.file === "MEMORY.md" ? row.file : `memory/${row.file}`;
  return (
    <>
      <Text
        style={{ fontSize: ui(14), color: colors.foregroundMuted }}
      >{`${file} · ${relativeTime(row.at)} · ${journalSource(row)}`}</Text>
      <ChangeDiff colors={colors} row={row} file={file} />
      {!row.canUndo ? (
        <Text style={{ fontSize: ui(13), color: colors.foregroundMuted }}>
          The earlier version was too large to keep, so this can't be undone.
        </Text>
      ) : null}
      <SheetActions>
        <Button colors={colors} variant="ghost" label="Back" disabled={busy} onPress={actions.onBack} />
        <Button
          colors={colors}
          variant="default"
          label={busy ? "Undoing..." : "Undo"}
          disabled={!row.canUndo || busy}
          onPress={actions.onUndo}
        />
      </SheetActions>
    </>
  );
}

function ChangeDiff({ colors, row, file }: { colors: Colors; row: JournalRow; file: string }) {
  if (row.diff) {
    return (
      <ToolCallDetailsContent
        colors={colors}
        detail={{ type: "edit", filePath: file, unifiedDiff: row.diff }}
        maxHeight={420}
      />
    );
  }
  return (
    <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
      {row.kind === "deleted" ? "The file was deleted." : "Too large to show."}
    </Text>
  );
}

export function LogSheet({ colors, bot, onClose }: { colors: Colors; bot: Bot; onClose(): void }) {
  const query = useDailyLog(bot.id);
  const [open, setOpen] = useState<string | null>(null);
  const days = (query.data?.days ?? []).slice(0, DAYS);
  const now = new Date();

  if (open)
    return <LogDay colors={colors} bot={bot} day={open} onBack={() => setOpen(null)} onClose={onClose} />;
  return (
    <Modal title="Daily log" open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <Text style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
          After each finished turn the app adds a line: what the bot said and which tools it used. It isn't
          loaded into chats; the bot looks things up in it with search_chats.
        </Text>
        <SettingsCard>
          {days.length === 0 ? (
            <CardNote
              colors={colors}
              text={query.isLoading ? "Loading..." : "No entries yet"}
              loading={query.isLoading}
            />
          ) : null}
          {days.map((entry) => (
            <DrillRow
              key={entry.day}
              colors={colors}
              label={dayName(entry.day, now)}
              hint={`${entry.lines} ${entry.lines === 1 ? "entry" : "entries"}`}
              onPress={() => setOpen(entry.day)}
            />
          ))}
        </SettingsCard>
      </Modal.Content>
    </Modal>
  );
}

function LogDay({
  colors,
  bot,
  day,
  onBack,
  onClose,
}: {
  colors: Colors;
  bot: Bot;
  day: string;
  onBack(): void;
  onClose(): void;
}) {
  const log = useRpc(memoryLogRpc);
  const remove = useRpc(memoryLogDeleteRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const text = useQuery({ queryKey: [...logKey(bot.id), day], queryFn: () => log({ botId: bot.id, day }) });

  const destroy = async () => {
    const label = dayName(day, new Date());
    if (
      !(await confirmDialog({
        title: "Delete log",
        message: `Delete the log for ${label}? This cannot be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await remove({ botId: bot.id, day });
      await queryClient.invalidateQueries({ queryKey: logKey(bot.id) });
      onBack();
    } catch (error) {
      toast.error(`Couldn't delete: ${errorText(error)}`);
    }
  };

  return (
    <Modal title={`memory/log/${day}.md`} open onOpenChange={(value) => !value && onClose()}>
      <Modal.Content>
        <View
          style={{
            padding: 16,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: colors.surface1,
            minHeight: 120,
          }}
        >
          {text.data ? (
            <Text
              selectable
              {...MONO_PROPS}
              style={{
                fontFamily: MONO_FONT,
                fontSize: code(),
                lineHeight: codeLine(),
                color: colors.foreground,
              }}
            >
              {text.data.text?.trim() || "This day's log is empty."}
            </Text>
          ) : (
            <ActivityIndicator size="small" color={colors.foregroundMuted} />
          )}
        </View>
        <SheetActions
          leading={
            <Button
              colors={colors}
              variant="ghost"
              label="Delete"
              icon="Trash2"
              onPress={() => void destroy()}
            />
          }
        >
          <Button colors={colors} variant="default" label="Back" onPress={onBack} />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}
