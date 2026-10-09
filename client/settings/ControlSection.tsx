import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsAction, SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { botSettings, type ControlSettings } from "../../shared/bot";
import { controlRotateRpc, controlStatusRpc, proposalListRpc } from "../../shared/rpc";
import { ProposalCard } from "../chat/stream/ProposalCard";
import { confirmDialog, errorText } from "../native";
import { CardNote } from "../panel/rows";
import { STATE_POLL_MS } from "../state-query";

type Colors = PluginSurfaceProps["theme"]["colors"];

function usePendingControlProposals() {
  const list = useRpc(proposalListRpc);
  return useQuery({
    queryKey: ["paseo-bots", "control-proposals"],
    queryFn: () => list({ status: "pending", origin: "control" }),
    refetchInterval: STATE_POLL_MS,
  });
}

function PendingChanges({ colors, compact }: { colors: Colors; compact: boolean }) {
  const pending = usePendingControlProposals();
  const proposals = pending.data?.proposals ?? [];
  if (!proposals.length) return null;
  return (
    <>
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} colors={colors} compact={compact} proposalId={proposal.id} />
      ))}
    </>
  );
}

function EndpointRows({ onRotate }: { onRotate(): void }) {
  const status = useRpc(controlStatusRpc);
  const toast = useToast();
  const info = useQuery({
    queryKey: ["paseo-bots", "control-status"],
    queryFn: () => status({}),
    refetchInterval: STATE_POLL_MS,
  });
  const url = info.data?.url;
  const command = info.data?.command ?? "";
  const copy = (text: string, done: string) =>
    void copyText(text).then(() => toast.show(done, { variant: "success" }));
  return (
    <>
      <SettingsAction
        label="Client config"
        hint={command ? `Starts ${command}` : "Starting..."}
        actionLabel="Copy"
        disabled={!url}
        onPress={() =>
          copy(
            JSON.stringify({ mcpServers: { "paseo-bots": { command } } }, null, 2),
            "MCP client config copied",
          )
        }
      />
      <SettingsAction
        label="Endpoint"
        hint={url ? `${url}, token in ${info.data?.tokenFile}` : "Starting..."}
        actionLabel="Copy"
        disabled={!url}
        onPress={() => copy(url ?? "", "Endpoint copied")}
      />
      <SettingsAction
        label="Rotate token"
        hint="Clients that use the old token stop working."
        actionLabel="Rotate"
        onPress={onRotate}
      />
    </>
  );
}

export function ControlSection({ colors, compact }: { colors: Colors; compact: boolean }) {
  const settings = useSettings(botSettings);
  const rotate = useRpc(controlRotateRpc);
  const toast = useToast();
  const values = settings.status === "ready" ? settings.values : null;
  const change = (patch: Partial<ControlSettings>) => {
    if (settings.status === "ready") void settings.save({ ...settings.values, ...patch }, settings.revision);
  };
  const confirmRotate = async () => {
    const confirmed = await confirmDialog({
      title: "Rotate token?",
      message: "MCP clients that use the current token stop working until they read the new one.",
      confirmLabel: "Rotate",
      destructive: true,
    });
    if (!confirmed) return;
    await rotate({})
      .then(() => toast.show("Token rotated", { variant: "success" }))
      .catch((error: unknown) => toast.error(errorText(error)));
  };

  return (
    <SettingsSection
      title="External control (MCP)"
      info="Lets MCP clients such as Claude Code, Cursor, Hermes or omp manage bots on this host, with or without the app open. Bot chats can't reach it."
    >
      <SettingsCard>
        {values ? null : <CardNote colors={colors} text="Loading..." loading />}
        <SettingsSwitch
          label="External control (MCP)"
          hint="Listens on 127.0.0.1 for clients that hold its token."
          value={values?.externalControl ?? false}
          disabled={!values}
          onValueChange={(externalControl) => change({ externalControl })}
        />
        <SettingsSwitch
          label="Allow elevated changes without approval"
          hint="Off: the Browser server, approval modes that don't ask, always-allowed commands and new MCP servers wait for you below."
          value={values?.allowElevated ?? false}
          disabled={!values}
          onValueChange={(allowElevated) => change({ allowElevated })}
        />
        {values?.externalControl ? <EndpointRows onRotate={() => void confirmRotate()} /> : null}
      </SettingsCard>
      <PendingChanges colors={colors} compact={compact} />
    </SettingsSection>
  );
}
