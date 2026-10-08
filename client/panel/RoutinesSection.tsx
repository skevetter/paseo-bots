import { useRpc } from "@getpaseo/plugin/client";
import { copyText, Modal, type ToastApi, useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { type Bot, newRoutineId, type Routine, type RoutineSchedule } from "../../shared/bot";
import { displayTitle, ROUTINE_LABEL } from "../../shared/chat";
import {
  CRON_PRESETS,
  describeCron,
  describeSchedule,
  formatLocalDateTime,
  nextRun,
  parseLocalDateTime,
  scheduleToCron,
  upcomingRuns,
  validateCron,
} from "../../shared/routines";
import {
  type RoutineRecord,
  type RoutineRun,
  routineRunNowRpc,
  routineStatusRpc,
  routineWebhookRpc,
} from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { type BotHost, useBotChats, useBotHost } from "../data";
import { confirmDialog, errorText } from "../native";
import type { PaseoAgent } from "../paseo";
import { type MenuEntry, useMenu } from "../ui/Menu";
import type { PanelProps } from "./BotPanel";
import {
  Alert,
  type BadgeVariant,
  Button,
  CardNote,
  DrillRow,
  InputField,
  KebabButton,
  PressableRow,
  RowText,
  SectionLink,
  SheetFooter,
  StatusBadge,
  TextAreaField,
} from "./controls";

type Colors = PanelProps["colors"];

/** Matches Paseo's formatNextRun (utils/schedule-format.ts). */
function formatNextRun(next: Date, now: number = Date.now()): string {
  const diff = next.getTime() - now;
  if (diff < 60_000) return "soon";
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`;
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`;
  return `in ${Math.round(diff / 86_400_000)}d`;
}

function routineState(routine: Routine, next: Date | null): { label: string; variant: BadgeVariant } {
  if (!routine.enabled) return { label: "Paused", variant: "muted" };
  // A webhook routine has no next time but stays ready to run.
  if (!next && routine.schedule.kind !== "webhook") return { label: "Finished", variant: "muted" };
  return { label: "Active", variant: "success" };
}

/** Status is left to the badge. */
function routineMeta(routine: Routine, run: RoutineRun | undefined, next: Date | null): string {
  const parts = [describeSchedule(routine.schedule)];
  const when = relativeTime(run?.startedAt);
  if (!run) parts.push("Never run");
  else if (run.status === "failed") parts.push(`Failed ${when}: ${run.error ?? "unknown error"}`);
  else if (run.status === "skipped-busy") parts.push(`Skipped ${when}, still working`);
  else if (run.status === "skipped-missed") parts.push(`Missed ${when}`);
  else parts.push(`Last run ${when}`);
  if (routine.enabled && next) parts.push(`Next run ${formatNextRun(next)}`);
  return parts.join(" · ");
}

const ROUTINES_KEY = ["paseo-bots", "routines"];
const UPCOMING = 6;
const UPCOMING_DAYS = 7;
const RECENT = 10;
const RUN_LABELS: Record<RoutineRun["status"], string> = {
  running: "Running",
  succeeded: "Done",
  failed: "Failed",
  "skipped-busy": "Skipped, still working",
  "skipped-missed": "Missed",
};
const TRIGGER_LABELS: Record<RoutineRun["trigger"], string> = {
  schedule: "on schedule",
  manual: "run by you",
  webhook: "from its webhook",
};

function runTime(at: Date, now: Date): string {
  const time = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const offset = Math.round((day - today) / 86_400_000);
  if (offset === 0) return `Today ${time}`;
  if (offset === 1) return `Tomorrow ${time}`;
  if (offset === -1) return `Yesterday ${time}`;
  return `${at.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} ${time}`;
}

type UpcomingRun = { at: Date; routine: Routine };
type RecentRun = { run: RoutineRun; routine: Routine };
type RecordOf = (routine: Routine) => RoutineRecord | undefined;

interface RoutineActions {
  setRoutines(routines: Routine[]): void;
  update(id: string, patch: Partial<Routine>): void;
  run(routine: Routine): Promise<void>;
  copyWebhook(routine: Routine): Promise<void>;
  remove(routine: Routine): Promise<void>;
}

function upcomingRunsOf(routines: Routine[], recordOf: RecordOf, now: Date): UpcomingRun[] {
  return routines
    .filter((routine) => routine.enabled)
    .flatMap((routine) =>
      upcomingRuns(
        routine.schedule,
        new Date(recordOf(routine)?.lastRunAt ?? routine.createdAt),
        now,
        UPCOMING,
      ).map((at) => ({ at, routine })),
    )
    .filter(({ at }) => at.getTime() - now.getTime() <= UPCOMING_DAYS * 86_400_000)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, UPCOMING);
}

function recentRunsOf(routines: Routine[], recordOf: RecordOf): RecentRun[] {
  return routines
    .flatMap((routine) => (recordOf(routine)?.runs ?? []).map((entry) => ({ run: entry, routine })))
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, RECENT);
}

function runsSummary(upcoming: UpcomingRun[], recent: RecentRun[], now: Date): string {
  const [nextUp] = upcoming;
  const [latest] = recent;
  return (
    [
      nextUp ? `Next ${runTime(nextUp.at, now)}` : null,
      latest ? `last ${runTime(new Date(latest.run.startedAt), now)}` : null,
    ]
      .filter(Boolean)
      .join(", ") || "None yet"
  );
}

function showRunOutcome(toast: ToastApi, routine: Routine, botName: string, started: RoutineRun) {
  if (started.status === "running")
    toast.show(`Started "${routine.name}". It appears as a chat under ${botName}.`, {
      variant: "success",
    });
  else if (started.status === "skipped-busy")
    toast.show(`"${routine.name}" is still working on its last run.`);
  else toast.error(started.error ?? "Couldn't start the run.");
}

function useRoutineActions({
  bot,
  onPatch,
  flush,
}: Pick<PanelProps, "bot" | "onPatch" | "flush">): RoutineActions {
  const runNow = useRpc(routineRunNowRpc);
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const queryClient = useQueryClient();

  const setRoutines = (routines: Routine[]) => onPatch({ routines });
  const update = (id: string, patch: Partial<Routine>) =>
    setRoutines(bot.routines.map((routine) => (routine.id === id ? { ...routine, ...patch } : routine)));

  const run = async (routine: Routine) => {
    try {
      await flush();
      const { run: started } = await runNow({ botId: bot.id, routineId: routine.id });
      showRunOutcome(toast, routine, bot.name, started);
      void queryClient.invalidateQueries({ queryKey: ["paseo-bots"] });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const copyWebhook = async (routine: Routine) => {
    try {
      await flush();
      await copyText((await webhook({ routineId: routine.id })).url);
      toast.show("Webhook URL copied", { variant: "success" });
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const remove = async (routine: Routine) => {
    const confirmed = await confirmDialog({
      title: "Delete routine",
      message: `Delete "${routine.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (confirmed) setRoutines(bot.routines.filter((entry) => entry.id !== routine.id));
  };

  return { setRoutines, update, run, copyWebhook, remove };
}

function routineMenuEntries(routine: Routine, actions: RoutineActions, onEdit: () => void): MenuEntry[] {
  return [
    { label: "Edit routine", icon: "Pencil", onSelect: onEdit },
    routine.enabled
      ? {
          label: "Pause routine",
          icon: "Pause",
          onSelect: () => actions.update(routine.id, { enabled: false }),
        }
      : {
          label: "Resume routine",
          icon: "Play",
          onSelect: () => actions.update(routine.id, { enabled: true }),
        },
    {
      label: "Run now",
      icon: "RotateCw",
      disabled: !routine.prompt.trim(),
      pendingLabel: "Starting...",
      onSelect: () => actions.run(routine),
    },
    ...(routine.schedule.kind === "webhook"
      ? [
          {
            label: "Copy webhook URL",
            icon: "Webhook",
            onSelect: () => actions.copyWebhook(routine),
          },
        ]
      : []),
    { kind: "separator" },
    {
      label: "Delete routine",
      icon: "Trash2",
      destructive: true,
      onSelect: () => void actions.remove(routine),
    },
  ];
}

function RoutineRow({
  colors,
  routine,
  record,
  now,
  actions,
  onEdit,
}: {
  colors: Colors;
  routine: Routine;
  record: RoutineRecord | undefined;
  now: Date;
  actions: RoutineActions;
  onEdit(): void;
}) {
  const menu = useMenu();
  const next = nextRun(routine.schedule, new Date(record?.lastRunAt ?? routine.createdAt), now);
  const badge = routineState(routine, next);
  return (
    <PressableRow colors={colors} accessibilityLabel={`Edit routine ${routine.name}`} onPress={onEdit}>
      {() => (
        <>
          <RowText
            colors={colors}
            label={routine.name || "Untitled routine"}
            hint={routineMeta(routine, record?.runs.at(-1), next)}
            hintLines={2}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <StatusBadge colors={colors} label={badge.label} variant={badge.variant} />
            <KebabButton
              colors={colors}
              label="Routine actions"
              onOpen={(anchor) =>
                menu.open({
                  anchor,
                  align: "end",
                  width: 220,
                  title: routine.name || "Routine",
                  entries: routineMenuEntries(routine, actions, onEdit),
                })
              }
            />
          </View>
        </>
      )}
    </PressableRow>
  );
}

function runHint(entry: RoutineRun, now: Date): string {
  return [
    `${runTime(new Date(entry.startedAt), now)} · ${RUN_LABELS[entry.status]} · ${TRIGGER_LABELS[entry.trigger]}`,
    entry.error ?? entry.output,
  ]
    .filter(Boolean)
    .join("\n");
}

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

function RunsModal({
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

const CUSTOM_CRON = "Custom cron";
const ONCE = "once";
const WEBHOOK = "webhook";
const OWN_CHAT = "own";

function inAnHour(): Date {
  const at = new Date(Date.now() + 60 * 60_000);
  at.setSeconds(0, 0);
  return at;
}

interface RoutineFormProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  routine: Routine | null;
  onCancel(): void;
  onSubmit(routine: Routine): void;
}

function presetValueOf(schedule: RoutineSchedule, trimmedCron: string): string {
  if (schedule.kind === "once") return ONCE;
  if (schedule.kind === "webhook") return WEBHOOK;
  return CRON_PRESETS.find((preset) => preset.expression === trimmedCron)?.id ?? CUSTOM_CRON;
}

function onceErrorOf(
  schedule: RoutineSchedule,
  original: RoutineSchedule,
  onceDate: Date | null,
): string | null {
  if (schedule.kind !== "once") return null;
  if (!onceDate) return "Use YYYY-MM-DD HH:MM";
  const onceChanged = original.kind !== "once" || onceDate.getTime() !== new Date(original.at).getTime();
  return onceChanged && onceDate.getTime() <= Date.now() ? "Pick a time in the future" : null;
}

interface Cadence {
  schedule: RoutineSchedule;
  cronText: string;
  trimmedCron: string;
  cronKey: number;
  cronError: string | null;
  onceText: string;
  onceDate: Date | null;
  onceError: string | null;
  presetValue: string;
  choosePreset(value: string): void;
  editOnce(text: string): void;
  editCron(text: string): void;
}

function useCadence(original: RoutineSchedule): Cadence {
  const [schedule, setSchedule] = useState<RoutineSchedule>(original);
  const [cronText, setCronText] = useState(() => scheduleToCron(original) ?? "0 9 * * *");
  const [onceText, setOnceText] = useState(() =>
    formatLocalDateTime(original.kind === "once" ? new Date(original.at) : inAnHour()),
  );
  // Presets rewrite the cron field; remounting resets it.
  const [cronKey, setCronKey] = useState(0);

  const once = schedule.kind === "once";
  const trimmedCron = cronText.trim();
  const onceDate = once ? parseLocalDateTime(onceText) : null;

  const choosePreset = (value: string) => {
    if (value === ONCE) {
      setSchedule({
        kind: "once",
        at: (parseLocalDateTime(onceText) ?? inAnHour()).toISOString(),
      });
      return;
    }
    if (value === WEBHOOK) {
      setSchedule({ kind: "webhook" });
      return;
    }
    const preset = CRON_PRESETS.find((entry) => entry.id === value);
    if (!preset) return;
    setCronText(preset.expression);
    setCronKey((key) => key + 1);
    setSchedule({ kind: "cron", expression: preset.expression });
  };
  const editOnce = (text: string) => {
    setOnceText(text);
    const at = parseLocalDateTime(text);
    if (at) setSchedule({ kind: "once", at: at.toISOString() });
  };
  const editCron = (text: string) => {
    setCronText(text);
    setSchedule({ kind: "cron", expression: text.trim() });
  };

  return {
    schedule,
    cronText,
    trimmedCron,
    cronKey,
    cronError: once || schedule.kind === "webhook" ? null : validateCron(trimmedCron),
    onceText,
    onceDate,
    onceError: onceErrorOf(schedule, original, onceDate),
    presetValue: presetValueOf(schedule, trimmedCron),
    choosePreset,
    editOnce,
    editCron,
  };
}

function ScheduleField({
  colors,
  routineId,
  cadence,
}: {
  colors: Colors;
  routineId: string;
  cadence: Cadence;
}) {
  if (cadence.schedule.kind === "webhook") return <WebhookRows routineId={routineId} />;
  if (cadence.schedule.kind === "once") {
    return (
      <InputField
        colors={colors}
        key="once"
        label="At"
        hint={cadence.onceDate ? cadence.onceDate.toLocaleString() : "YYYY-MM-DD HH:MM"}
        error={cadence.onceError}
        initialValue={cadence.onceText}
        placeholder="2026-09-27 09:00"
        onChangeText={cadence.editOnce}
      />
    );
  }
  const { trimmedCron } = cadence;
  return (
    <InputField
      colors={colors}
      key={`cron-${cadence.cronKey}`}
      label="Cron"
      monospace
      autoCapitalize="none"
      autoCorrect={false}
      hint={trimmedCron ? (describeCron(trimmedCron) ?? trimmedCron) : undefined}
      error={cadence.cronError}
      initialValue={cadence.cronText}
      placeholder="0 9 * * *"
      onChangeText={cadence.editCron}
    />
  );
}

function CadenceSection({
  colors,
  routineId,
  cadence,
}: {
  colors: Colors;
  routineId: string;
  cadence: Cadence;
}) {
  return (
    <SettingsSection
      title="Cadence"
      info="In this host's local time. A run that's still working when the next is due is skipped."
    >
      <SettingsCard>
        <SettingsSelect
          label="Repeats"
          value={cadence.presetValue}
          options={[
            ...CRON_PRESETS.map((preset) => ({ label: preset.label, value: preset.id })),
            { label: "Once", value: ONCE },
            { label: "When its webhook is called", value: WEBHOOK },
          ]}
          onValueChange={cadence.choosePreset}
        />
        <ScheduleField colors={colors} routineId={routineId} cadence={cadence} />
      </SettingsCard>
    </SettingsSection>
  );
}

function ResultsSection({
  chats,
  resultsChatId,
  onChange,
}: {
  chats: PaseoAgent[];
  resultsChatId: string | null;
  onChange(resultsChatId: string | null): void;
}) {
  // Runs' own chats aren't offered as a results chat; a chosen chat that's gone stays listed so it can be changed.
  const resultChats = chats.filter((chat) => !chat.labels?.[ROUTINE_LABEL]);
  const resultOptions = [
    { label: "Only the run's own chat", value: OWN_CHAT },
    ...resultChats.map((chat) => ({ label: displayTitle(chat.title), value: chat.id })),
    ...(resultsChatId && !resultChats.some((chat) => chat.id === resultsChatId)
      ? [{ label: "A chat that's no longer here", value: resultsChatId }]
      : []),
  ];
  return (
    <SettingsSection
      title="Results"
      info="Every run has its own chat. A results chat also gets a card for each run with how it went."
    >
      <SettingsCard>
        <SettingsSelect
          label="Post results to"
          value={resultsChatId ?? OWN_CHAT}
          options={resultOptions}
          onValueChange={(value) => onChange(value === OWN_CHAT ? null : value)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function RoutineForm({ colors, bot, host, routine, onCancel, onSubmit }: RoutineFormProps) {
  const original: RoutineSchedule = routine?.schedule ?? { kind: "cron", expression: "0 9 * * 1-5" };
  // A new routine's id is picked now so its webhook URL can be shown before saving.
  const [id] = useState(() => routine?.id ?? newRoutineId());
  const [name, setName] = useState(routine?.name ?? "");
  const [prompt, setPrompt] = useState(routine?.prompt ?? "");
  const [resultsChatId, setResultsChatId] = useState<string | null>(routine?.resultsChatId ?? null);
  const cadence = useCadence(original);
  const chats = useBotChats(host, bot.id);
  const canSubmit = prompt.trim().length > 0 && !cadence.cronError && !cadence.onceError;

  const submit = () => {
    const [firstLine = ""] = prompt.trim().split("\n");
    const { schedule } = cadence;
    const base: Routine = routine ?? {
      id,
      name: "",
      prompt: "",
      enabled: true,
      schedule,
      resultsChatId: null,
      createdAt: new Date().toISOString(),
    };
    onSubmit({
      ...base,
      name: name.trim().slice(0, 80) || firstLine.slice(0, 60),
      prompt,
      schedule,
      resultsChatId,
    });
  };

  return (
    <Modal title={routine ? "Edit routine" : "New routine"} open onOpenChange={(open) => !open && onCancel()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        <View style={{ marginBottom: 24 }}>
          <SettingsCard>
            <InputField
              colors={colors}
              label="Name"
              initialValue={name}
              placeholder="Morning check-in"
              onChangeText={setName}
            />
            <TextAreaField
              colors={colors}
              label="Prompt"
              hint="Sent as the first message of each run"
              defaultValue={prompt}
              onChangeText={setPrompt}
              placeholder="What should the bot do each run?"
            />
          </SettingsCard>
        </View>
        <CadenceSection colors={colors} routineId={id} cadence={cadence} />
        <ResultsSection chats={chats.data ?? []} resultsChatId={resultsChatId} onChange={setResultsChatId} />
        <SheetFooter>
          <Button colors={colors} size="md" label="Cancel" onPress={onCancel} style={{ flex: 1 }} />
          <Button
            colors={colors}
            size="md"
            variant="default"
            label={routine ? "Save changes" : "Create routine"}
            disabled={!canSubmit}
            onPress={submit}
            style={{ flex: 1 }}
          />
        </SheetFooter>
      </Modal.Content>
    </Modal>
  );
}

function WebhookRows({ routineId }: { routineId: string }) {
  const webhook = useRpc(routineWebhookRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const key = ["paseo-bots", "webhook", routineId];
  const url = useQuery({ queryKey: key, queryFn: () => webhook({ routineId }) });

  const rotate = async () => {
    const confirmed = await confirmDialog({
      title: "New webhook URL",
      message: "The current URL stops working. Anything that calls it needs the new one.",
      confirmLabel: "Replace",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      queryClient.setQueryData(key, await webhook({ routineId, rotate: true }));
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const value = url.data?.url;
  const copy = () => {
    if (!value) return;
    void copyText(value).then(() => toast.show("Webhook URL copied", { variant: "success" }));
  };
  return (
    <>
      <SettingsAction
        label="Webhook URL"
        hint={value ?? (url.isError ? errorText(url.error) : "Loading...")}
        actionLabel="Copy"
        disabled={!value}
        onPress={copy}
      />
      <SettingsAction
        label="New URL"
        hint="POST to it from this computer; the body reaches the bot as data, not instructions."
        actionLabel="Replace"
        disabled={!value}
        onPress={() => void rotate()}
      />
    </>
  );
}
