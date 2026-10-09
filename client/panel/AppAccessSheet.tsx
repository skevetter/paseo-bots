import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/react-native";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import { type AppAccount, type AppTool, accountLabel, filterAppTools, ruleAccount } from "../../shared/apps";
import type { AppRule } from "../../shared/bot";
import { appsToolsRpc } from "../../shared/rpc";
import { APPS_KEY } from "../library/apps";
import { readOnlyToolsHint } from "../library/status";
import { errorText } from "../native";
import { Button, SheetActions } from "./controls";
import { SearchField } from "./fields";
import { CardNote, SectionMeta } from "./rows";

type Colors = PluginTheme["colors"];
type Mode = "all" | "read" | "chosen";
type ToolsQuery = UseQueryResult<{ tools: AppTool[] }>;

function initialMode(rule: AppRule | undefined): Mode {
  if (Array.isArray(rule?.tools)) return "chosen";
  return rule?.tools ?? "all";
}

/** The relay enforces the account and tool limits chosen here. */
export function AppAccessSheet({
  colors,
  app,
  accounts,
  rule,
  onClose,
  onSave,
}: {
  colors: Colors;
  app: { slug: string; name: string };
  accounts: readonly AppAccount[];
  rule: AppRule | undefined;
  onClose(): void;
  onSave(rule: AppRule): void;
}) {
  const appTools = useRpc(appsToolsRpc);
  const tools = useQuery({
    queryKey: [...APPS_KEY, "tools", app.slug],
    queryFn: () => appTools({ slug: app.slug }),
    staleTime: 10 * 60_000,
  });
  const list = tools.data?.tools ?? [];
  const [account, setAccount] = useState(ruleAccount(rule, accounts));
  const [mode, setMode] = useState<Mode>(initialMode(rule));
  const [chosen, setChosen] = useState<string[]>(Array.isArray(rule?.tools) ? rule.tools : []);
  const [query, setQuery] = useState("");
  const readOnly = list.filter((tool) => tool.readOnly);

  const pick = (next: Mode) => {
    if (next === "chosen" && chosen.length === 0) setChosen(readOnly.map((tool) => tool.slug));
    setMode(next);
  };

  return (
    <Modal title={app.name} open onOpenChange={(open) => !open && onClose()}>
      <Modal.Content contentContainerStyle={{ gap: 0 }}>
        {accounts.length > 1 ? (
          <AccountSection appName={app.name} accounts={accounts} account={account} onChange={setAccount} />
        ) : null}
        <ToolsModeSection
          mode={mode}
          hint={mode === "read" ? readOnlyToolsHint(tools, readOnly.length, list.length) : undefined}
          onPick={pick}
        />
        {mode === "chosen" ? (
          <ChosenToolsSection
            colors={colors}
            appName={app.name}
            tools={tools}
            chosen={chosen}
            onChosenChange={setChosen}
            query={query}
            onQueryChange={setQuery}
          />
        ) : null}
        <SheetActions>
          <Button colors={colors} variant="ghost" label="Cancel" onPress={onClose} />
          <Button
            colors={colors}
            variant="default"
            label="Save"
            disabled={mode === "chosen" && chosen.length === 0}
            onPress={() => onSave({ tools: mode === "chosen" ? chosen : mode, account })}
          />
        </SheetActions>
      </Modal.Content>
    </Modal>
  );
}

function AccountSection({
  appName,
  accounts,
  account,
  onChange,
}: {
  appName: string;
  accounts: readonly AppAccount[];
  account: string | null;
  onChange(account: string | null): void;
}) {
  return (
    <SettingsSection title="Account" info="With any account, the bot picks one by its name.">
      <SettingsCard>
        <SettingsSelect
          label="Account"
          value={account ?? ""}
          options={[
            { label: "Any account", value: "" },
            ...accounts.map((entry) => ({ label: accountLabel(entry, appName), value: entry.id })),
          ]}
          onValueChange={(value) => onChange(value || null)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ToolsModeSection({
  mode,
  hint,
  onPick,
}: {
  mode: Mode;
  hint: string | undefined;
  onPick(mode: Mode): void;
}) {
  return (
    <SettingsSection
      title="Tools"
      info="Read-only allows the tools Composio marks as only reading, including ones it adds later."
    >
      <SettingsCard>
        <SettingsSelect
          label="Allowed tools"
          hint={hint}
          value={mode}
          options={[
            { label: "All tools", value: "all" },
            { label: "Read-only", value: "read" },
            { label: "Chosen tools", value: "chosen" },
          ]}
          onValueChange={(value) => onPick(value as Mode)}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function ChosenToolsSection({
  colors,
  appName,
  tools,
  chosen,
  onChosenChange,
  query,
  onQueryChange,
}: {
  colors: Colors;
  appName: string;
  tools: ToolsQuery;
  chosen: string[];
  onChosenChange(update: (current: string[]) => string[]): void;
  query: string;
  onQueryChange(query: string): void;
}) {
  const list = tools.data?.tools ?? [];
  const needle = query.trim().toLowerCase();
  const shown = filterAppTools(list, needle);

  return (
    <SettingsSection
      title="Chosen tools"
      trailing={
        tools.data ? <SectionMeta colors={colors} text={`${chosen.length} of ${list.length}`} /> : undefined
      }
    >
      {list.length > 12 ? (
        <View style={{ marginBottom: 12 }}>
          <SearchField
            colors={colors}
            value={query}
            onChangeText={onQueryChange}
            placeholder={`Search ${appName} tools`}
          />
        </View>
      ) : null}
      <SettingsCard>
        {toolsStatusNotes({ colors, tools, empty: shown.length === 0, filtered: Boolean(needle) })}
        {shown.map((tool) => (
          <SettingsSwitch
            key={tool.slug}
            label={tool.name}
            hint={tool.readOnly ? `${tool.slug} · read-only` : tool.slug}
            value={chosen.includes(tool.slug)}
            onValueChange={(on) =>
              onChosenChange((current) =>
                on ? [...current, tool.slug] : current.filter((slug) => slug !== tool.slug),
              )
            }
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}

function toolsStatusNotes({
  colors,
  tools,
  empty,
  filtered,
}: {
  colors: Colors;
  tools: ToolsQuery;
  empty: boolean;
  filtered: boolean;
}) {
  return [
    tools.isLoading ? <CardNote key="loading" colors={colors} loading text="Loading tools..." /> : null,
    tools.error ? (
      <SettingsRow key="error" label="Couldn't load the tools" error={errorText(tools.error)} />
    ) : null,
    tools.data && empty ? (
      <CardNote key="empty" colors={colors} text={filtered ? "No tools match" : "This app has no tools"} />
    ) : null,
  ];
}
