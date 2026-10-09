import { useRpc } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CRON_PRESETS, describeCron } from "../../../shared/routines";
import { routineWebhookRpc } from "../../../shared/rpc";
import { confirmDialog, errorText } from "../../native";
import type { PanelProps } from "../BotPanel";
import { InputField } from "../controls";
import { type Cadence, ONCE, WEBHOOK } from "./cadence";

type Colors = PanelProps["colors"];

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

export function CadenceSection({
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
