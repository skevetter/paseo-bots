import { Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { View } from "react-native";
import type { Bot, Routine, RoutineSchedule } from "../../../shared/bot";
import { newRoutineId } from "../../../shared/bot-ids";

import { displayTitle, ROUTINE_LABEL } from "../../../shared/chat";
import { type BotHost, useBotChats } from "../../data";
import type { PaseoAgent } from "../../paseo";
import type { PanelProps } from "../BotPanel";
import { Button, InputField, SheetFooter, TextAreaField } from "../controls";
import { CadenceSection } from "./CadenceSection";
import { useCadence } from "./cadence";

type Colors = PanelProps["colors"];

const OWN_CHAT = "own";

interface RoutineFormProps {
  colors: Colors;
  bot: Bot;
  host: BotHost;
  routine: Routine | null;
  onCancel(): void;
  onSubmit(routine: Routine): void;
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

export function RoutineForm({ colors, bot, host, routine, onCancel, onSubmit }: RoutineFormProps) {
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
