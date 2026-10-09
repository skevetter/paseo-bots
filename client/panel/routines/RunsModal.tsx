import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { PanelProps } from "../BotPanel";
import { CardNote, DrillRow } from "../rows";
import { type RecentRun, runHint, runTime, UPCOMING_DAYS, type UpcomingRun } from "./runs";

type Colors = PanelProps["colors"];

function RecentRunRow({
  colors,
  recent: { run: entry, routine },
  now,
  onOpenChat,
}: {
  colors: Colors;
  recent: RecentRun;
  now: Date;
  onOpenChat(agentId: string): void;
}) {
  const hint = runHint(entry, now);
  const agentId = entry.agentId;
  return agentId ? (
    <DrillRow
      colors={colors}
      label={routine.name}
      hint={hint}
      hintLines={2}
      onPress={() => onOpenChat(agentId)}
    />
  ) : (
    <SettingsRow label={routine.name} hint={hint} />
  );
}

export function RunsModal({
  colors,
  upcoming,
  recent,
  now,
  onClose,
  onOpenChat,
}: {
  colors: Colors;
  upcoming: UpcomingRun[];
  recent: RecentRun[];
  now: Date;
  onClose(): void;
  onOpenChat(agentId: string): void;
}) {
  return (
    <Modal title="Runs" open onOpenChange={(next) => !next && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <SettingsSection
          title="Upcoming"
          info={`The next runs over the coming ${UPCOMING_DAYS} days, in this host's local time.`}
        >
          <SettingsCard>
            {upcoming.length === 0 ? <CardNote colors={colors} text="Nothing scheduled" /> : null}
            {upcoming.map(({ at, routine }) => (
              <SettingsRow
                key={`${routine.id}:${at.getTime()}`}
                label={runTime(at, now)}
                hint={routine.name}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
        <SettingsSection
          title="Recent runs"
          info="The latest runs of this bot's routines. Open one to see its chat."
        >
          <SettingsCard>
            {recent.length === 0 ? <CardNote colors={colors} text="No runs yet" /> : null}
            {recent.map((entry) => (
              <RecentRunRow
                key={entry.run.id}
                colors={colors}
                recent={entry}
                now={now}
                onOpenChat={onOpenChat}
              />
            ))}
          </SettingsCard>
        </SettingsSection>
      </Modal.Content>
    </Modal>
  );
}
