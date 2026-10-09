import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Bot, BotState } from "../../../shared/bot";
import { changeWarnings, describeChange } from "../../../shared/changes/describe";
import type { Proposal } from "../../../shared/proposals";
import { describeSchedule, upcomingRuns } from "../../../shared/routines";
import { proposalAcceptRpc, proposalDismissRpc, proposalGetRpc } from "../../../shared/rpc";
import { scanSkillText, skillBody } from "../../../shared/skills";
import { skillQueryKey } from "../../library/SkillPage";
import { errorText } from "../../native";
import { Alert } from "../../panel/status";
import { ui } from "../../typography";
import { useBotState } from "../../useBotState";
import { CardButton } from "./buttons";
import { PlanCard } from "./PlanCard";

type Colors = PluginTheme["colors"];
type Busy = "save" | "dismiss" | null;

const proposalQueryKey = (id: string) => ["paseo-bots", "proposal", id];

const OUTCOME = { pending: "pending", accepted: "approved", dismissed: "rejected" } as const;

export function ProposalCard({
  colors,
  compact,
  proposalId,
}: {
  colors: Colors;
  compact: boolean;
  proposalId: string;
}) {
  const get = useRpc(proposalGetRpc);
  const query = useQuery({ queryKey: proposalQueryKey(proposalId), queryFn: () => get({ id: proposalId }) });
  const proposal = query.data?.proposal;

  if (query.isPending) return null;
  if (!proposal) {
    return (
      <Text style={{ marginVertical: 12, fontSize: ui(14), color: colors.foregroundMuted }}>
        {query.isError
          ? `Couldn't load the proposal: ${errorText(query.error)}`
          : "This proposal is no longer available."}
      </Text>
    );
  }

  return (
    <ProposalBody
      colors={colors}
      compact={compact}
      proposal={proposal}
      refetch={() => void query.refetch()}
    />
  );
}

function ProposalBody({
  colors,
  compact,
  proposal,
  refetch,
}: {
  colors: Colors;
  compact: boolean;
  proposal: Proposal;
  refetch: () => void;
}) {
  const { settings } = useBotState();
  const { busy, save, drop } = useProposalActions({ proposal, reload: settings.reload, refetch });
  const view = proposalView(proposal, settings.status === "ready" ? settings.values : null);

  return (
    <PlanCard
      colors={colors}
      title={view.titles[proposal.status]}
      description={view.description}
      text={view.text}
      outcome={OUTCOME[proposal.status]}
      footer={
        proposal.status === "pending" ? (
          <ProposalFooter
            colors={colors}
            compact={compact}
            view={view}
            busy={busy}
            onDismiss={() => void drop()}
            onSave={() => void save()}
          />
        ) : undefined
      }
    />
  );
}

function ProposalFooter({
  colors,
  compact,
  view,
  busy,
  onDismiss,
  onSave,
}: {
  colors: Colors;
  compact: boolean;
  view: ProposalView;
  busy: Busy;
  onDismiss: () => void;
  onSave: () => void;
}) {
  return (
    <>
      {view.warnings.length ? (
        <Alert colors={colors} variant="warning" title="Check these first" description={view.warnings} />
      ) : null}
      {view.notes.map((note) => (
        <Text key={note} style={{ fontSize: ui(14), color: colors.foregroundMuted }}>
          {note}
        </Text>
      ))}
      <View
        style={
          compact
            ? { gap: 8, marginTop: 4 }
            : { gap: 8, marginTop: 4, flexDirection: "row", flexWrap: "wrap", alignItems: "center" }
        }
      >
        <CardButton
          colors={colors}
          label="Dismiss"
          icon="X"
          busy={!!busy}
          spinning={busy === "dismiss"}
          onPress={onDismiss}
        />
        <CardButton
          colors={colors}
          label={view.action}
          icon="Check"
          primary
          busy={!!busy}
          spinning={busy === "save"}
          onPress={onSave}
        />
      </View>
    </>
  );
}

function useProposalActions({
  proposal,
  reload,
  refetch,
}: {
  proposal: Proposal;
  reload: () => Promise<void>;
  refetch: () => void;
}) {
  const accept = useRpc(proposalAcceptRpc);
  const dismiss = useRpc(proposalDismissRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<Busy>(null);

  const save = async () => {
    setBusy("save");
    try {
      const { proposal: saved, skill } = await accept({ id: proposal.id });
      queryClient.setQueryData(proposalQueryKey(proposal.id), { proposal: saved });
      await reload();
      if (skill) void queryClient.invalidateQueries({ queryKey: skillQueryKey(skill.id) });
    } catch (error) {
      toast.error(`Couldn't save it: ${errorText(error)}`);
      refetch();
    } finally {
      setBusy(null);
    }
  };

  const drop = async () => {
    setBusy("dismiss");
    try {
      queryClient.setQueryData(proposalQueryKey(proposal.id), await dismiss({ id: proposal.id }));
    } catch (error) {
      toast.error(`Couldn't dismiss it: ${errorText(error)}`);
      refetch();
    } finally {
      setBusy(null);
    }
  };

  return { busy, save, drop };
}

function proposalView(proposal: Proposal, values: BotState | null): ProposalView {
  const bot = values?.bots.find((entry) => entry.id === proposal.botId);
  switch (proposal.kind) {
    case "skill":
      return skillView(
        proposal,
        bot,
        !!values?.library?.skills.some((skill) => skill.id === proposal.data.name),
      );
    case "routine":
      return routineView(proposal, bot);
    case "changes":
      return changesView(proposal);
    case "command":
      return commandView(proposal, bot);
    case "import":
      return importView(proposal);
  }
}

interface ProposalView {
  titles: Record<Proposal["status"], string>;
  description: string;
  text: string;
  warnings: string[];
  notes: string[];
  action: string;
}

function skillView(
  proposal: Extract<Proposal, { kind: "skill" }>,
  bot: Bot | undefined,
  exists: boolean,
): ProposalView {
  const { name, description, text } = proposal.data;
  return {
    titles: {
      pending: `${exists ? "Updated" : "New"} skill: ${name}`,
      accepted: `Saved skill: ${name}`,
      dismissed: `Dismissed skill: ${name}`,
    },
    description,
    text: skillBody(text),
    warnings: scanSkillText(text),
    notes: [
      `${exists ? `Replace ${name} in Skills & Tools` : "Save it to Skills & Tools"}${bot ? ` and turn it on for ${bot.name}?` : "?"}`,
    ],
    action: exists ? "Update skill" : "Save skill",
  };
}

function routineView(proposal: Extract<Proposal, { kind: "routine" }>, bot: Bot | undefined): ProposalView {
  const { name, prompt, schedule } = proposal.data;
  const now = new Date();
  const next = upcomingRuns(schedule, now, now, 3);
  const timing =
    schedule.kind === "webhook"
      ? "It runs when its webhook is called. Copy the URL from the routine's settings."
      : next.length
        ? `Next ${next.length === 1 ? "run" : `${next.length} runs`}: ${next.map((at) => at.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })).join(" · ")}`
        : "It has no upcoming runs.";
  return {
    titles: {
      pending: `New routine: ${name}`,
      accepted: `Scheduled routine: ${name}`,
      dismissed: `Dismissed routine: ${name}`,
    },
    description: describeSchedule(schedule),
    text: prompt,
    warnings: [],
    notes: [timing, `Each run starts a new chat${bot ? ` with ${bot.name}` : ""} and posts its result here.`],
    action: "Create routine",
  };
}

function changesView(proposal: Extract<Proposal, { kind: "changes" }>): ProposalView {
  const { summary, changes } = proposal.data;
  const count = changes.length === 1 ? "the change" : `all ${changes.length} changes`;
  return {
    titles: {
      pending: "Setup changes",
      accepted: "Applied setup changes",
      dismissed: "Dismissed setup changes",
    },
    description: summary,
    text: changes.map((change) => `- ${describeChange(change)}`).join("\n"),
    warnings: changeWarnings(changes),
    notes: [`Apply ${count}? A bot's earlier settings stay under History in its settings.`],
    action: "Apply changes",
  };
}

function commandView(proposal: Extract<Proposal, { kind: "command" }>, bot: Bot | undefined): ProposalView {
  const who = bot?.name ?? "The bot";
  return {
    titles: {
      pending: "Always allow a command",
      accepted: "Allowed a command",
      dismissed: "Dismissed a command",
    },
    description: `In ${proposal.data.cwd}`,
    text: `\`\`\`\n${proposal.data.command}\n\`\`\``,
    warnings: [`${who} runs this command without asking you, in that folder only.`],
    notes: ["Remove it later under Access in the bot's settings."],
    action: "Allow command",
  };
}

function importView(proposal: Extract<Proposal, { kind: "import" }>): ProposalView {
  const { summary, bots, teams } = proposal.data;
  const servers = [...new Set(bots.flatMap((entry) => entry.mcpServers.map((server) => server.name)))];
  return {
    titles: {
      pending: "Import bots",
      accepted: "Imported bots",
      dismissed: "Dismissed an import",
    },
    description: summary,
    text: [
      ...bots.map((entry) => `- **${entry.bot.name}**`),
      ...teams.map((team) => `- Team **${team.name}**`),
    ].join("\n"),
    warnings: servers.length
      ? [`Adds the MCP servers ${servers.join(", ")} to Skills & Tools, switched off.`]
      : [],
    notes: ["Routines arrive paused and skills need a review."],
    action: "Import",
  };
}
