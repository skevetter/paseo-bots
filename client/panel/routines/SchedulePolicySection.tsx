import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { RoutineSchedule } from "../../../shared/bot";
import { CatchUpSchema, recoveryOf, SchedulePolicySchema } from "../../../shared/schedule-policy";
import type { PanelProps } from "../BotPanel";
import { Button } from "../controls";
import { InputField } from "../fields";
import { CadenceSection } from "./CadenceSection";
import type { Cadence } from "./cadence";
import type { PreviewResult } from "./schedule-editor";
import type { ScheduleEditor } from "./useScheduleEditor";

type Colors = PanelProps["colors"];

function PolicyFields({ colors, editor }: { colors: Colors; editor: ScheduleEditor }) {
  const { policy } = editor;
  if (!policy) {
    return (
      <SettingsAction
        label="Legacy host-local schedule"
        hint="Keeps this host's local-time interpretation. Adopt an explicit policy only if you want to change it."
        actionLabel="Adopt explicit policy"
        onPress={editor.adopt}
      />
    );
  }
  return (
    <>
      <InputField
        colors={colors}
        label="IANA time zone"
        initialValue={policy.timeZone}
        placeholder="America/New_York"
        autoCapitalize="none"
        autoCorrect={false}
        error={editor.policyError}
        onChangeText={(timeZone) => editor.changePolicy({ ...policy, timeZone })}
      />
      <SettingsSelect
        label="DST gap (missing local time)"
        value={policy.gap}
        options={[
          { label: "Skip the missing occurrence", value: "skip" },
          { label: "Shift forward by the clock change", value: "shift_forward" },
        ]}
        onValueChange={(value) =>
          editor.changePolicy({ ...policy, gap: SchedulePolicySchema.shape.gap.parse(value) })
        }
      />
      <SettingsSelect
        label="DST repeat (local time occurs twice)"
        value={policy.repeat}
        options={[
          { label: "First instant only", value: "first" },
          { label: "Second instant only", value: "second" },
          { label: "Both instants", value: "both" },
        ]}
        onValueChange={(value) =>
          editor.changePolicy({ ...policy, repeat: SchedulePolicySchema.shape.repeat.parse(value) })
        }
      />
    </>
  );
}

function RecoveryFields({ colors, editor }: { colors: Colors; editor: ScheduleEditor }) {
  const { policy } = editor;
  if (!policy) return null;
  const { catchUp, jitterToleranceSeconds } = recoveryOf(policy);
  return (
    <SettingsSection
      title="Recovery and jitter"
      info="Selects recovery candidates; existing overlap and capacity rules still apply. Legacy runs retain their skip-on-overlap behavior."
    >
      <SettingsCard>
        <SettingsSelect
          label="Recovery strategy"
          value={catchUp.strategy}
          options={[
            { label: "Latest occurrence only", value: "latest" },
            { label: "Recover several occurrences", value: "queue" },
            { label: "Coalesce into the latest occurrence", value: "coalesce" },
          ]}
          onValueChange={(value) =>
            editor.changePolicy({
              ...policy,
              catchUp: { ...catchUp, strategy: CatchUpSchema.shape.strategy.parse(value) },
            })
          }
        />
        <InputField
          colors={colors}
          label="Recovery window (seconds)"
          hint="60 to 604800 seconds. Older occurrences are recorded as suppressed, not successful."
          initialValue={String(catchUp.windowSeconds)}
          keyboardType="number-pad"
          onChangeText={(value) =>
            editor.changePolicy({ ...policy, catchUp: { ...catchUp, windowSeconds: Number(value) } })
          }
        />
        <InputField
          colors={colors}
          label="Maximum recovered occurrences"
          hint="1 to 100 candidates when recovering several; latest and coalesce select one."
          initialValue={String(catchUp.maxOccurrences)}
          keyboardType="number-pad"
          onChangeText={(value) =>
            editor.changePolicy({ ...policy, catchUp: { ...catchUp, maxOccurrences: Number(value) } })
          }
        />
        <InputField
          colors={colors}
          label="Permitted jitter (seconds)"
          hint="0 disables jitter. Up to 3600 seconds of deterministic start offset; capacity or host delays may add latency."
          initialValue={String(jitterToleranceSeconds)}
          keyboardType="number-pad"
          onChangeText={(value) => editor.changePolicy({ ...policy, jitterToleranceSeconds: Number(value) })}
        />
        {editor.policyError ? (
          <Text accessibilityRole="alert" style={{ padding: 16, color: colors.statusDanger }}>
            {editor.policyError}
          </Text>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function PreviewOccurrences({ colors, result }: { colors: Colors; result: PreviewResult }) {
  const zone = result.schedulePolicy?.timeZone ?? "host-local time";
  return (
    <View style={{ padding: 16, gap: 10 }}>
      <Text style={{ color: colors.foregroundMuted }}>
        {result.elapsed
          ? "Elapsed intervals; timezone is display-only."
          : result.legacyLocalTime
            ? "Legacy host-local interpretation."
            : `Explicit timezone: ${zone}.`}
      </Text>
      {result.occurrences.map((occurrence) => (
        <View key={occurrence.at} style={{ gap: 2 }}>
          <Text selectable style={{ color: colors.foreground }}>
            {occurrence.at}
          </Text>
          <Text selectable style={{ color: colors.foregroundMuted }}>
            {occurrence.localTime} ({zone})
          </Text>
        </View>
      ))}
      {result.occurrences.length === 0 ? (
        <Text style={{ color: colors.foregroundMuted }}>No scheduled occurrences after this date.</Text>
      ) : null}
    </View>
  );
}

function OccurrencePreview({
  colors,
  editor,
  schedule,
  since,
  invalid,
}: {
  colors: Colors;
  editor: ScheduleEditor;
  schedule: RoutineSchedule;
  since: string;
  invalid: boolean;
}) {
  return (
    <SettingsSection
      title="Occurrence preview"
      info="Computed by the host from this unsaved schedule. Previewing does not run the bot."
    >
      <SettingsCard>
        <InputField
          colors={colors}
          label="Preview after (ISO UTC)"
          initialValue={editor.after}
          hint={
            schedule.kind === "interval"
              ? `Elapsed interval anchor: ${since}`
              : "Select a date near a spring or fall clock change to inspect DST behavior."
          }
          error={editor.afterError}
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={editor.changeAfter}
        />
        <View style={{ padding: 16 }}>
          <Button
            colors={colors}
            label={editor.preview.pending ? "Loading preview..." : "Preview next 5 occurrences"}
            disabled={invalid || !!editor.afterError || editor.preview.pending}
            onPress={() => void editor.loadPreview({ schedule, since })}
          />
        </View>
        {editor.preview.error ? (
          <Text accessibilityRole="alert" style={{ padding: 16, color: colors.statusDanger }}>
            {editor.preview.error}
          </Text>
        ) : null}
        {editor.preview.result ? <PreviewOccurrences colors={colors} result={editor.preview.result} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

export function SchedulePolicySection(props: {
  colors: Colors;
  editor: ScheduleEditor;
  cadence: Cadence;
  routineId: string;
  since: string;
  invalid: boolean;
}) {
  return (
    <>
      <CadenceSection
        colors={props.colors}
        routineId={props.routineId}
        cadence={{
          ...props.cadence,
          choosePreset: (value) => {
            props.editor.invalidate();
            props.cadence.choosePreset(value);
          },
          editOnce: (value) => {
            props.editor.invalidate();
            props.cadence.editOnce(value);
          },
          editInterval: (value) => {
            props.editor.invalidate();
            props.cadence.editInterval(value);
          },
          editCron: (value) => {
            props.editor.invalidate();
            props.cadence.editCron(value);
          },
        }}
      />
      <SettingsSection
        title="Timezone and DST policy"
        info="Applies to wall-clock schedules. Intervals are elapsed time; once is an absolute instant and webhooks are event-driven."
      >
        <SettingsCard>
          <PolicyFields colors={props.colors} editor={props.editor} />
        </SettingsCard>
      </SettingsSection>
      <RecoveryFields colors={props.colors} editor={props.editor} />
      <OccurrencePreview {...props} schedule={props.cadence.schedule} />
    </>
  );
}
