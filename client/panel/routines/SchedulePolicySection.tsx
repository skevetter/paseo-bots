import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import type { RoutineSchedule } from "../../../shared/bot";
import { SchedulePolicySchema } from "../../../shared/schedule-policy";
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
      <OccurrencePreview {...props} schedule={props.cadence.schedule} />
    </>
  );
}
