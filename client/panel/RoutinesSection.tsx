import { useRpc } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import type { Routine } from "../../shared/bot";
import { routineStatusRpc } from "../../shared/rpc";
import { useBotHost } from "../data";
import type { PanelProps } from "./BotPanel";
import { Alert, CardNote, DrillRow, SectionLink } from "./controls";
import { RoutineForm } from "./routines/RoutineForm";
import { RoutineRow } from "./routines/RoutineRow";
import { RunsModal } from "./routines/RunsModal";
import { recentRunsOf, runsSummary, upcomingRunsOf } from "./routines/runs";
import { useRoutineActions } from "./routines/useRoutineActions";

const ROUTINES_KEY = ["paseo-bots", "routines"];

export function RoutinesSection({ colors, bot, localHost, onPatch, flush, onOpenChat }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useRpc(routineStatusRpc);
  const actions = useRoutineActions({ bot, onPatch, flush });
  const records = useQuery({
    queryKey: ROUTINES_KEY,
    queryFn: () => status({}),
    refetchInterval: 15_000,
    enabled: host.isLocal,
  });
  const [editing, setEditing] = useState<Routine | "new" | null>(null);
  const [runs, setRuns] = useState(false);
  const recordOf = (routine: Routine) => records.data?.routines[routine.id];

  if (!host.isLocal) {
    return (
      <Alert
        colors={colors}
        description="Routines run on the host that stores the bot. Switch the bot to this host to schedule it."
      />
    );
  }

  const now = new Date();
  const upcoming = upcomingRunsOf(bot.routines, recordOf, now);
  const recent = recentRunsOf(bot.routines, recordOf);
  const save = (routine: Routine) => {
    actions.setRoutines(
      editing === "new"
        ? [...bot.routines, routine]
        : bot.routines.map((entry) => (entry.id === routine.id ? routine : entry)),
    );
    setEditing(null);
  };

  return (
    <>
      {records.data?.scheduler === false ? (
        <View style={{ marginBottom: 24 }}>
          <Alert colors={colors} variant="warning" description="The scheduler on this host is starting" />
        </View>
      ) : null}
      <SettingsSection
        title="Routines"
        info="Each run starts a new chat under this bot with the routine's prompt, at the bot's mode. Runs missed by under 12 hours catch up once."
        trailing={<SectionLink colors={colors} label="New routine" onPress={() => setEditing("new")} />}
      >
        <SettingsCard>
          {bot.routines.length === 0 ? <CardNote colors={colors} text="No routines yet" /> : null}
          {bot.routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              colors={colors}
              routine={routine}
              record={recordOf(routine)}
              now={now}
              actions={actions}
              onEdit={() => setEditing(routine)}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      {bot.routines.length ? (
        <SettingsSection title="Activity">
          <SettingsCard>
            <DrillRow
              colors={colors}
              label="Runs"
              hint={runsSummary(upcoming, recent, now)}
              onPress={() => setRuns(true)}
            />
          </SettingsCard>
        </SettingsSection>
      ) : null}
      {runs ? (
        <RunsModal
          colors={colors}
          upcoming={upcoming}
          recent={recent}
          now={now}
          onClose={() => setRuns(false)}
          onOpenChat={(agentId) => {
            setRuns(false);
            onOpenChat(agentId);
          }}
        />
      ) : null}
      {editing ? (
        <RoutineForm
          colors={colors}
          bot={bot}
          host={host}
          routine={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSubmit={save}
        />
      ) : null}
    </>
  );
}
