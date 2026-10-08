import { type PluginHostSummary, useHosts, useRpc } from "@getpaseo/plugin/client";
import { Modal, useToast } from "@getpaseo/plugin/client/react-native";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { APPS_MCP_NAME } from "../../shared/apps";
import { botMcpServers, toolGrants } from "../../shared/bot";
import { TOOLS_MCP_NAME } from "../../shared/bot-tools";
import type { PaseoToolsState } from "../../shared/paseo-tools";
import { commandListRpc, commandRemoveRpc } from "../../shared/rpc";
import {
  type BotHost,
  type LocalHost,
  useAgentProfiles,
  useBotHost,
  useHostWorkspaces,
  usePaseoTools,
  useProviders,
} from "../data";
import { errorText } from "../native";
import type { PaseoProviderEntry } from "../paseo";
import { AppsPicker } from "./AppsPicker";
import type { PanelProps } from "./BotPanel";
import {
  AdvancedToggle,
  CardNote,
  DrillRow,
  InputField,
  SectionMeta,
  StatusBadge,
  TextAreaField,
} from "./controls";
import { LibraryPicker } from "./LibraryPicker";

const MANAGED = "__managed__";
/** Not an option; SettingsSelect shows a value outside its options as-is. */
const CUSTOM = "Custom";
const ABSOLUTE_PATH = /^(\/|~(\/|$)|[A-Za-z]:[\\/]|\\\\)/;

type Bot = PanelProps["bot"];
type ProviderEntry = PaseoProviderEntry;

interface AgentProfile {
  id: string;
  name: string;
  provider: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export function AccessSection(props: PanelProps) {
  const { colors, bot, localHost, onPatch } = props;
  // Starts open when its settings are in use, so they aren't hidden.
  const [advanced, setAdvanced] = useState(bot.cwd !== null || bot.alwaysAllow.length > 0);
  return (
    <>
      <PaseoToolsSection colors={colors} bot={bot} localHost={localHost} />
      <LibraryPicker
        {...props}
        kind="mcp"
        title="MCP servers"
        info="Added on top of the MCP servers the provider already loads. Paseo's own tools are always included. Add and edit servers in Skills & Tools."
      />
      <AppsPicker colors={colors} bot={bot} localHost={localHost} onPatch={onPatch} />
      <AdvancedToggle colors={colors} open={advanced} onToggle={() => setAdvanced(!advanced)} />
      {advanced ? (
        <>
          <FolderSection {...props} />
          <GrantsSection {...props} />
        </>
      ) : null}
    </>
  );
}

function FolderSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const workspaces = useHostWorkspaces(host);
  const [pathText, setPathText] = useState(bot.cwd ?? "");
  // Picking a folder from the list rewrites the path field; remounting resets its text.
  const [pathKey, setPathKey] = useState(0);
  const options = [
    ...(host.isLocal ? [{ label: "Shared", value: MANAGED }] : []),
    ...(workspaces.data ?? []).map((workspace) => ({ label: workspace.label, value: workspace.directory })),
  ];
  const folderValue = folderSelectValue(bot.cwd, host.isLocal, options);
  const pathError = pathText.trim() && !ABSOLUTE_PATH.test(pathText.trim()) ? "Use an absolute path" : null;
  return (
    <SettingsSection
      title="Working folder"
      info="Where the bot's chats run. The shared folder keeps every bot chat in one Bots workspace."
    >
      <SettingsCard>
        <SettingsSelect
          label="Folder"
          value={folderValue}
          options={options}
          onValueChange={(next) => {
            const cwd = next === MANAGED ? null : next;
            onPatch({ cwd });
            setPathText(cwd ?? "");
            setPathKey((key) => key + 1);
          }}
        />
        <InputField
          colors={colors}
          key={pathKey}
          label="Path"
          hint={host.isLocal ? "Empty uses the shared Bots folder" : "A folder on the bot's host"}
          error={pathError}
          initialValue={pathText}
          placeholder={host.isLocal ? "Shared Bots folder" : "/Users/me/work"}
          onChangeText={(text) => {
            setPathText(text);
            const trimmed = text.trim();
            if (!trimmed) onPatch({ cwd: null });
            else if (ABSOLUTE_PATH.test(trimmed)) onPatch({ cwd: trimmed });
          }}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function folderSelectValue(
  cwd: string | null,
  isLocal: boolean,
  options: readonly { value: string }[],
): string {
  if (cwd === null) return isLocal ? MANAGED : "Choose a folder";
  return options.some((option) => option.value === cwd) ? cwd : CUSTOM;
}

function GrantsSection({ colors, bot, library, localHost, onPatch }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const [allowText, setAllowText] = useState(bot.alwaysAllow.join("\n"));
  const lines = allowText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  // Only grants for the bot's own servers are sent; Paseo rejects the rest.
  const active = new Set([
    ...botMcpServers(bot, library).map((server) => server.name),
    ...(host.isLocal && bot.apps.length ? [APPS_MCP_NAME] : []),
    ...(host.isLocal ? [TOOLS_MCP_NAME] : []),
  ]);
  const grants = toolGrants(lines).filter((grant) => active.has(grant.server));
  const ignored = lines.length - grants.length;
  return (
    <SettingsSection
      title="Always allowed"
      info={
        'Tools from the bot\'s MCP servers it may use without asking, one "server/tool" per line. Only providers with exact tool grants (Claude, Codex, OpenCode) accept these.'
      }
      trailing={
        <SectionMeta
          colors={colors}
          text={`${grants.length} valid${ignored ? ` · ${ignored} ignored` : ""}`}
          tone={ignored ? "warning" : undefined}
        />
      }
    >
      <SettingsCard>
        <TextAreaField
          colors={colors}
          monospace
          accessibilityLabel="Always allowed tools"
          value={allowText}
          onChangeText={(text) => {
            setAllowText(text);
            onPatch({
              alwaysAllow: text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            });
          }}
          autoCapitalize="none"
          autoCorrect={false}
          minHeight={72}
          placeholder={"gmail/search_threads\nfetch/fetch"}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function paseoToolsLabel(state: PaseoToolsState | null, loading: boolean): string {
  if (state) return state.on ? "Included in every chat" : "Turned off";
  return loading ? "Checking..." : "Couldn't read the host's settings";
}

function paseoToolsHint(state: PaseoToolsState | null, provider: string, hostLabel: string): string | null {
  if (!state) return null;
  if (state.on) return "Other agents, workspaces, terminals, schedules and the browser";
  if (state.reason === "provider") return `Off for ${provider} on ${hostLabel}`;
  if (state.reason === "host") return `Off for every agent on ${hostLabel}`;
  return `Paseo's MCP server is off on ${hostLabel}`;
}

function PaseoToolsSection({ colors, bot, localHost }: Pick<PanelProps, "colors" | "bot" | "localHost">) {
  const host = useBotHost(bot.hostId, localHost);
  const tools = usePaseoTools(host, bot.provider);
  const [busy, setBusy] = useState(false);
  const state = tools.state;
  const label = paseoToolsLabel(state, tools.loading);
  const hint = paseoToolsHint(state, bot.provider, host.label);
  return (
    <SettingsSection
      title="Paseo tools"
      info="Paseo gives every agent it starts its own tools, bots included. Changing this changes it for all agents on the host."
    >
      <SettingsCard>
        {state && !state.on && state.reason !== "mcp" ? (
          <SettingsAction
            label={label}
            hint={hint ?? undefined}
            actionLabel={busy ? "Turning on..." : "Turn on"}
            disabled={busy}
            onPress={() => {
              setBusy(true);
              void tools.turnOn().finally(() => setBusy(false));
            }}
          />
        ) : (
          <SettingsRow label={label} hint={hint ?? undefined}>
            {state?.on ? <StatusBadge colors={colors} label="On" variant="success" /> : null}
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

export function ModelSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const hosts = useHosts();
  const providers = useProviders(host);
  const profiles = useAgentProfiles(host);
  // Starts open when another host is set, so it isn't hidden.
  const [advanced, setAdvanced] = useState(bot.hostId !== null);

  return (
    <>
      <AgentSection bot={bot} providers={providers.data} loading={providers.isLoading} onPatch={onPatch} />

      <AdvancedToggle colors={colors} open={advanced} onToggle={() => setAdvanced(!advanced)} />
      {advanced ? (
        <WhereItRunsSection
          bot={bot}
          host={host}
          hosts={hosts}
          localHost={localHost}
          profiles={profiles.data ?? []}
          onPatch={onPatch}
        />
      ) : null}
    </>
  );
}

function AgentSection({
  bot,
  providers,
  loading,
  onPatch,
}: {
  bot: Bot;
  providers: readonly ProviderEntry[] | undefined;
  loading: boolean;
  onPatch: PanelProps["onPatch"];
}) {
  const provider = providers?.find((entry) => entry.provider === bot.provider);
  const models = (provider?.models ?? []).filter((model) => model.isSelectable !== false);
  const model = models.find((entry) => entry.id === bot.model);
  const thinking = model?.thinkingOptions ?? models.find((entry) => entry.isDefault)?.thinkingOptions ?? [];
  const providerPlaceholder = loading ? "Loading..." : "Choose a provider";
  return (
    <SettingsSection title="Agent" info="The provider and model each new chat and routine run starts with.">
      <SettingsCard>
        <SettingsSelect
          label="Provider"
          value={bot.provider || providerPlaceholder}
          disabled={loading}
          options={(providers ?? []).map((entry) => ({
            label: (entry.label ?? entry.provider) + (entry.status === "ready" ? "" : ` (${entry.status})`),
            value: entry.provider,
          }))}
          onValueChange={(value) => {
            const entry = providers?.find((candidate) => candidate.provider === value);
            onPatch({
              provider: value,
              model: null,
              modeId: entry?.defaultModeId ?? null,
              thinkingOptionId: null,
            });
          }}
        />
        <SettingsSelect
          label="Model"
          value={provider ? (bot.model ?? "") : "Choose a provider first"}
          disabled={!provider}
          options={
            provider
              ? [
                  { label: "Default", value: "" },
                  ...models.map((entry) => ({ label: entry.label, value: entry.id })),
                ]
              : []
          }
          onValueChange={(value) => onPatch({ model: value || null, thinkingOptionId: null })}
        />
        {thinking.length > 0 ? (
          <SettingsSelect
            label="Thinking"
            value={bot.thinkingOptionId ?? ""}
            options={[
              { label: "Default", value: "" },
              ...thinking.map((option) => ({ label: option.label, value: option.id })),
            ]}
            onValueChange={(value) => onPatch({ thinkingOptionId: value || null })}
          />
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function WhereItRunsSection({
  bot,
  host,
  hosts,
  localHost,
  profiles,
  onPatch,
}: {
  bot: Bot;
  host: BotHost;
  hosts: readonly PluginHostSummary[];
  localHost: LocalHost;
  profiles: readonly AgentProfile[];
  onPatch: PanelProps["onPatch"];
}) {
  return (
    <SettingsSection
      title="Where it runs"
      info="The Paseo host the bot's chats start on, and an agent profile that fills in the settings above."
    >
      <SettingsCard>
        <SettingsSelect
          label="Host"
          hint={host.isLocal ? "This host" : undefined}
          error={host.online ? null : `${host.label} is offline, so its providers can't be listed`}
          value={bot.hostId ?? ""}
          options={[
            { label: localHost.label, value: "" },
            ...hosts
              .filter((entry) => entry.serverId !== localHost.id)
              .map((entry) => ({
                label: `${entry.label}${entry.status === "online" ? "" : ` (${entry.status})`}`,
                value: entry.serverId,
              })),
          ]}
          onValueChange={(value) =>
            onPatch({
              hostId: value || null,
              provider: "",
              model: null,
              modeId: null,
              thinkingOptionId: null,
              cwd: value ? bot.cwd : null,
            })
          }
        />
        {profiles.length > 0 ? <ProfileSelect bot={bot} profiles={profiles} onPatch={onPatch} /> : null}
      </SettingsCard>
    </SettingsSection>
  );
}

function ProfileSelect({
  bot,
  profiles,
  onPatch,
}: {
  bot: Bot;
  profiles: readonly AgentProfile[];
  onPatch: PanelProps["onPatch"];
}) {
  const profile = profiles.find(
    (entry) => entry.provider === bot.provider && (entry.model ?? null) === bot.model,
  );
  return (
    <SettingsSelect
      label="Agent profile"
      hint="Fills in provider, model, mode and thinking"
      value={profile?.id ?? CUSTOM}
      options={profiles.map((entry) => ({ label: entry.name, value: entry.id }))}
      onValueChange={(id) => {
        const chosen = profiles.find((entry) => entry.id === id);
        if (chosen)
          onPatch({
            provider: chosen.provider,
            model: chosen.model ?? null,
            modeId: chosen.modeId ?? null,
            thinkingOptionId: chosen.thinkingOptionId ?? null,
          });
      }}
    />
  );
}

export function PermissionsSection({ colors, bot, localHost, onPatch }: PanelProps) {
  const host = useBotHost(bot.hostId, localHost);
  const providers = useProviders(host);
  const provider = providers.data?.find((entry) => entry.provider === bot.provider);
  return (
    <>
      <ApprovalSection bot={bot} provider={provider} onPatch={onPatch} />
      {host.isLocal ? <OtherBotsSection bot={bot} onPatch={onPatch} /> : null}
      {host.isLocal ? <AllowedCommands colors={colors} bot={bot} /> : null}
    </>
  );
}

function ApprovalSection({
  bot,
  provider,
  onPatch,
}: {
  bot: Bot;
  provider: ProviderEntry | undefined;
  onPatch: PanelProps["onPatch"];
}) {
  const modes = provider?.modes ?? [];
  const current = modes.find((mode) => mode.id === (bot.modeId ?? provider?.defaultModeId));
  return (
    <SettingsSection
      title="Approval"
      info="How much the bot may do before asking you. Also applies to its routines."
    >
      <SettingsCard>
        <SettingsSelect
          label="Mode"
          hint={
            provider
              ? current?.description
                ? `${current.label}: ${current.description}`
                : undefined
              : "Pick a provider under Model to see its modes"
          }
          value={provider ? (bot.modeId ?? "") : "Choose a provider first"}
          disabled={!provider}
          options={
            provider
              ? [
                  { label: "Default", value: "" },
                  ...modes.map((mode) => ({ label: mode.label, value: mode.id })),
                ]
              : []
          }
          onValueChange={(value) => onPatch({ modeId: value || null })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function OtherBotsSection({ bot, onPatch }: Pick<PanelProps, "bot" | "onPatch">) {
  return (
    <SettingsSection
      title="Other bots"
      info="Whether this bot may ask other bots on this host for help. Each request starts a chat under the other bot, which works with its own settings."
    >
      <SettingsCard>
        <SettingsSelect
          label="Contact other bots"
          hint={
            bot.contactBots === "ask"
              ? "You approve each request, when the mode asks before using tools"
              : bot.contactBots === "allow"
                ? "Without asking you first"
                : "Never"
          }
          value={bot.contactBots}
          options={[
            { label: "Ask first", value: "ask" },
            { label: "Allowed", value: "allow" },
            { label: "Off", value: "off" },
          ]}
          onValueChange={(contactBots) => onPatch({ contactBots })}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

/** Each is one exact command in one folder, added from its approval card. */
function AllowedCommands({ colors, bot }: Pick<PanelProps, "colors" | "bot">) {
  const list = useRpc(commandListRpc);
  const remove = useRpc(commandRemoveRpc);
  const toast = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const key = ["paseo-bots", "commands", bot.id];
  const rules = useQuery({ queryKey: key, queryFn: () => list({ botId: bot.id }) });
  const items = rules.data?.rules ?? [];
  const info =
    "Commands this bot runs without asking you: the exact command, in the exact folder. Add one with Always allow on the command's approval card.";
  return (
    <SettingsSection title="Commands" info={info}>
      <SettingsCard>
        <DrillRow
          colors={colors}
          label="Allowed commands"
          hint={
            rules.isLoading
              ? "Loading..."
              : items.length
                ? `${items.length} ${items.length === 1 ? "command" : "commands"}`
                : "None yet"
          }
          onPress={() => setOpen(true)}
        />
      </SettingsCard>
      {open ? (
        <Modal title="Allowed commands" open onOpenChange={(next) => !next && setOpen(false)}>
          <Modal.Content>
            <SettingsCard>
              {items.length === 0 ? (
                <CardNote
                  colors={colors}
                  text="None yet. Add one with Always allow on a command's approval card."
                />
              ) : null}
              {items.map((rule) => (
                <SettingsAction
                  key={rule.id}
                  label={rule.command}
                  hint={rule.cwd}
                  actionLabel="Remove"
                  onPress={() =>
                    void remove({ botId: bot.id, id: rule.id })
                      .then(() => queryClient.invalidateQueries({ queryKey: key }))
                      .catch((error: unknown) => toast.error(errorText(error)))
                  }
                />
              ))}
            </SettingsCard>
          </Modal.Content>
        </Modal>
      ) : null}
    </SettingsSection>
  );
}
