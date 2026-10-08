import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useAgent, usePaseo } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { AppAccount, AppSignIn } from "../../../shared/apps";
import { BOT_LABEL, type BotSettingsValues } from "../../../shared/bot";
import { useAppsAccounts, useAppsCatalog } from "../../library/apps";
import { AppLogo } from "../../library/parts";
import { errorText } from "../../native";
import { StatusBadge } from "../../panel/controls";
import { ui } from "../../typography";
import { useBotSettings } from "../../useBotSettings";
import { CardButton } from "./ui";

type Colors = PluginTheme["colors"];
type Phase = "idle" | "waiting" | "connected" | "continued";
type ConnectBot = { id: string; name: string; apps: readonly string[] };
type ConnectApp = { name: string; logo: string | null; domain: string | null };
type Badge = { label: string; variant: "success" | "muted" };

interface ConnectState {
  commit: (mutate: (values: BotSettingsValues) => BotSettingsValues) => Promise<boolean>;
  phase: Phase;
  setPhase: (phase: Phase) => void;
  app: ConnectApp;
  tracked: boolean;
  connected: boolean;
  bot: ConnectBot | undefined;
  expired: boolean;
}

/** Composio's sign-in links expire ten minutes after the bot asks for them. */
const LINK_TTL_MS = 10 * 60_000;

function isSignInAccount(account: AppAccount, signIn: AppSignIn): boolean {
  if (account.slug !== signIn.slug || account.status !== "connected") return false;
  return signIn.wordId ? account.wordId === signIn.wordId : account.alias === signIn.alias;
}

function lacksApp(bot: ConnectBot | undefined, slug: string): bot is ConnectBot {
  return !!bot && !bot.apps.includes(slug);
}

function connectBadge(done: boolean, phase: Phase, expired: boolean): Badge | null {
  if (done) return { label: "Connected", variant: "success" };
  if (phase === "waiting") return { label: "Waiting", variant: "muted" };
  if (expired) return { label: "Expired", variant: "muted" };
  return null;
}

function connectNote({
  phase,
  expired,
  appName,
  signIn,
  bot,
}: {
  phase: Phase;
  expired: boolean;
  appName: string;
  signIn: AppSignIn;
  bot: ConnectBot | undefined;
}): string {
  const who = bot?.name ?? "The bot";
  if (expired) return `The sign-in link has expired. Ask ${who} for a new one.`;
  if (phase === "waiting") return "Finish signing in in your browser. This card updates when it's done.";
  const account = signIn.alias ? ` as "${signIn.alias}"` : "";
  const alsoUses = lacksApp(bot, signIn.slug) ? ` Connecting also lets ${bot.name} use it.` : "";
  return `${who} asked to connect ${appName}${account}. You sign in on Composio's page.${alsoUses}`;
}

function useConnectState(signIn: AppSignIn, since: number, botId: string | null): ConnectState {
  const { settings, commit } = useBotSettings();
  const [phase, setPhase] = useState<Phase>("idle");
  const accounts = useAppsAccounts(true, phase === "waiting");
  const catalog = useAppsCatalog(true);
  const app: ConnectApp = catalog.data?.apps.find((entry) => entry.slug === signIn.slug) ?? {
    name: signIn.slug,
    logo: null,
    domain: null,
  };
  // Without the account's id or alias there's nothing to wait for, so Continue shows once the page is open.
  const tracked = !!(signIn.wordId || signIn.alias);
  const connected = !!accounts.data?.accounts.some((account) => isSignInAccount(account, signIn));
  const bot =
    settings.status === "ready" ? settings.values.bots.find((entry) => entry.id === botId) : undefined;
  const expired = !connected && phase === "idle" && Date.now() - since > LINK_TTL_MS;

  useEffect(() => {
    if (phase === "waiting" && connected) setPhase("connected");
  }, [phase, connected]);

  return { commit, phase, setPhase, app, tracked, connected, bot, expired };
}

function useConnectActions({
  signIn,
  agentId,
  state,
}: {
  signIn: AppSignIn;
  agentId: string | null;
  state: ConnectState;
}) {
  const paseo = usePaseo();
  const toast = useToast();
  const { commit, setPhase, app, tracked, bot } = state;

  const open = async () => {
    try {
      if (lacksApp(bot, signIn.slug)) {
        await commit((current) => ({
          ...current,
          bots: current.bots.map((entry) =>
            entry.id === bot.id ? { ...entry, apps: [...entry.apps, signIn.slug] } : entry,
          ),
        }));
      }
      await openExternalUrl(signIn.url);
      setPhase(tracked ? "waiting" : "connected");
    } catch (error) {
      toast.error(errorText(error));
    }
  };

  const carryOn = async () => {
    if (!agentId) return;
    try {
      await paseo.agents.ref(agentId).send(`${app.name} is connected. Please continue.`);
      setPhase("continued");
    } catch (error) {
      toast.error(`Couldn't send it: ${errorText(error)}`);
    }
  };

  return { open, carryOn };
}

function ConnectHeader({
  colors,
  app,
  done,
  badge,
}: {
  colors: Colors;
  app: ConnectApp;
  done: boolean;
  badge: Badge | null;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 24 }}>
      <AppLogo colors={colors} app={app} size={16} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: ui(14), lineHeight: 22 }}>
        {done ? `${app.name} connected` : `Connect ${app.name}`}
      </Text>
      {badge ? <StatusBadge colors={colors} label={badge.label} variant={badge.variant} /> : null}
    </View>
  );
}

/**
 * A sign-in a bot started with COMPOSIO_MANAGE_CONNECTIONS, as OpenMausBot's
 * connect card: the user opens Composio's page from here, the card waits for
 * the account to turn active, and Continue tells the bot. Connecting also
 * lets the bot use the app.
 */
export function ConnectCard({
  colors,
  signIn,
  since,
  agentId,
  botId,
}: {
  colors: Colors;
  signIn: AppSignIn;
  since: number;
  agentId: string | null;
  botId: string | null;
}) {
  const state = useConnectState(signIn, since, botId);
  const { open, carryOn } = useConnectActions({ signIn, agentId, state });
  const { phase, app, connected, bot, expired } = state;

  const done = connected || phase === "connected" || phase === "continued";
  const note = done ? null : connectNote({ phase, expired, appName: app.name, signIn, bot });

  return (
    <View
      style={{
        marginVertical: 12,
        padding: 12,
        borderRadius: 8,
        borderWidth: 1,
        backgroundColor: colors.surface1,
        borderColor: colors.border,
        gap: 8,
      }}
    >
      <ConnectHeader colors={colors} app={app} done={done} badge={connectBadge(done, phase, expired)} />
      {note ? (
        <Text style={{ color: colors.foregroundMuted, fontSize: ui(14), lineHeight: 20 }}>{note}</Text>
      ) : null}
      {!done && !expired ? (
        <View style={{ flexDirection: "row" }}>
          <CardButton
            colors={colors}
            label={phase === "waiting" ? "Open the page again" : "Sign in"}
            icon="ArrowUpRight"
            primary={phase === "idle"}
            onPress={() => void open()}
          />
        </View>
      ) : null}
      {phase === "connected" && agentId ? (
        <View style={{ flexDirection: "row" }}>
          <CardButton colors={colors} label="Continue" icon="Check" primary onPress={() => void carryOn()} />
        </View>
      ) : null}
    </View>
  );
}

/** The card in Paseo's own agent view, which knows the chat but not its bot. */
export function NativeConnectCard(props: {
  colors: Colors;
  signIn: AppSignIn;
  since: number;
  agentId: string;
}) {
  const botId = useAgent(props.agentId, (agent) => agent.labels[BOT_LABEL] ?? null);
  return <ConnectCard {...props} botId={botId} />;
}
