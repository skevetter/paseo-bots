import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { SettingsAction } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { FlatList, Text, useWindowDimensions } from "react-native";
import { SearchField } from "./fields";
import { PressableRow, RowText } from "./rows";

interface ModelChoice {
  id: string;
  label: string;
}

export function ModelPicker({
  colors,
  models,
  value,
  disabled,
  onChange,
}: {
  colors: PluginTheme["colors"];
  models: readonly ModelChoice[];
  value: string | null;
  disabled: boolean;
  onChange(value: string | null): void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { height } = useWindowDimensions();
  const needle = query.trim().toLowerCase();
  const choices = useMemo(
    () =>
      needle
        ? models.filter(
            (model) => model.label.toLowerCase().includes(needle) || model.id.toLowerCase().includes(needle),
          )
        : models,
    [models, needle],
  );
  const selected = models.find((model) => model.id === value);
  const choose = (id: string | null) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <>
      <SettingsAction
        label="Model"
        actionLabel={selected?.label ?? value ?? "Default"}
        hint={value ?? "Uses the provider default"}
        disabled={disabled}
        onPress={() => {
          setQuery("");
          setOpen(true);
        }}
      />
      {open ? (
        <Modal title="Choose model" open onOpenChange={setOpen}>
          <Modal.Content
            scrollable={false}
            style={{ maxHeight: height * 0.8 }}
            contentContainerStyle={{ padding: 16, gap: 12 }}
          >
            <SearchField
              colors={colors}
              value={query}
              onChangeText={setQuery}
              placeholder="Search model name or ID"
            />
            <SettingsAction label="Provider default" actionLabel="Use default" onPress={() => choose(null)} />
            <FlatList
              data={choices}
              keyExtractor={(model) => model.id}
              keyboardShouldPersistTaps="handled"
              style={{ height: Math.min(420, height * 0.45), flexShrink: 1 }}
              ListEmptyComponent={<Text style={{ color: colors.foregroundMuted }}>No matching models</Text>}
              renderItem={({ item }) => (
                <PressableRow
                  colors={colors}
                  accessibilityLabel={`Choose ${item.label}, ${item.id}${item.id === value ? ", selected" : ""}`}
                  onPress={() => choose(item.id)}
                >
                  {() => (
                    <>
                      <RowText colors={colors} label={item.label} hint={item.id} hintLines={2} />
                      {item.id === value ? <Icon name="Check" size={16} color={colors.accent} /> : null}
                    </>
                  )}
                </PressableRow>
              )}
            />
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
