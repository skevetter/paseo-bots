import { Icon } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSection } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { type AppAccount, type AppCard, accountLabel, withAppRule } from "../../shared/apps";
import type { AppRule } from "../../shared/bot";
import { useBotHost } from "../data";
import { connectedApps, useAppsAccounts, useAppsCatalog, useAppsStatus } from "../library/apps";
import { AppLogo } from "../library/parts";
import { openLibrary } from "../navigation";
import { AppAccessSheet } from "./AppAccessSheet";
import type { PanelProps } from "./BotPanel";
import { CardNote, PressableRow, RowText, SectionLink, Switch } from "./controls";

const STATUS_HINT = {
  connected: null,
  pending: "Waiting for sign-in",
  failed: "Sign-in failed. Connect it again in Skills & Tools.",
} as const;

type ConnectedApp = AppCard & { status: AppAccount["status"] };

function ruleHint(
  rule: AppRule | undefined,
  accounts: readonly AppAccount[],
  appName: string,
): string | null {
  if (!rule) return null;
  const account = accounts.find((entry) => entry.id === rule.account);
  const tools =
    rule.tools === "read"
      ? "Read-only"
      : Array.isArray(rule.tools)
        ? `${rule.tools.length} ${rule.tools.length === 1 ? "tool" : "tools"}`
        : null;
  return [tools, account ? accountLabel(account, appName) : null].filter(Boolean).join(" · ") || null;
}

export function AppsPicker({
  colors,
  bot,
  localHost,
  onPatch,
}: Pick<PanelProps, "colors" | "bot" | "localHost" | "onPatch">) {
  const host = useBotHost(bot.hostId, localHost);
  const status = useAppsStatus();
  const configured = status.data?.configured ?? false;
  const accounts = useAppsAccounts(configured);
  const catalog = useAppsCatalog(configured);
  const apps = connectedApps(accounts.data?.accounts ?? [], catalog.data?.apps ?? []);
  const [editing, setEditing] = useState<string | null>(null);
  const editingApp = apps.find((app) => app.slug === editing);
  const appAccounts = (slug: string) =>
    (accounts.data?.accounts ?? []).filter(
      (account) => account.slug === slug && account.status === "connected",
    );
  const toggle = (slug: string, on: boolean) =>
    onPatch({ apps: on ? [...new Set([...bot.apps, slug])] : bot.apps.filter((entry) => entry !== slug) });

  return (
    <SettingsSection
      title="Connected apps"
      info="Apps signed in through Composio on this host. Switched-on apps are reachable through the bot's composio MCP server. Open one to limit its tools or keep the bot to one account."
      trailing={
        <SectionLink
          colors={colors}
          icon="ArrowUpRight"
          label="Skills & Tools"
          onPress={() => openLibrary({ kind: "apps" })}
        />
      }
    >
      <SettingsCard>
        {appsStatusNotes({
          colors,
          isLocal: host.isLocal,
          notSetUp: Boolean(status.data) && !configured,
          loading: configured && accounts.isLoading,
          empty: configured && !accounts.isLoading && apps.length === 0,
        })}
        {host.isLocal && configured
          ? apps.map((app) => (
              <AppRow
                key={app.slug}
                colors={colors}
                app={app}
                hint={
                  STATUS_HINT[app.status] ?? ruleHint(bot.appRules[app.slug], appAccounts(app.slug), app.name)
                }
                on={bot.apps.includes(app.slug)}
                onToggle={(on) => toggle(app.slug, on)}
                onOpen={() => setEditing(app.slug)}
              />
            ))
          : null}
      </SettingsCard>
      {editingApp ? (
        <AppAccessSheet
          colors={colors}
          app={editingApp}
          accounts={appAccounts(editingApp.slug)}
          rule={bot.appRules[editingApp.slug]}
          onClose={() => setEditing(null)}
          onSave={(rule) => {
            onPatch({ appRules: withAppRule(bot.appRules, editingApp.slug, rule) });
            setEditing(null);
          }}
        />
      ) : null}
    </SettingsSection>
  );
}

function appsStatusNotes({
  colors,
  isLocal,
  notSetUp,
  loading,
  empty,
}: {
  colors: PanelProps["colors"];
  isLocal: boolean;
  notSetUp: boolean;
  loading: boolean;
  empty: boolean;
}) {
  if (!isLocal)
    return [<CardNote key="remote" colors={colors} text="Only bots on this host can use connected apps" />];
  return [
    notSetUp ? <CardNote key="setup" colors={colors} text="Not set up yet" /> : null,
    loading ? <CardNote key="loading" colors={colors} loading text="Loading..." /> : null,
    empty ? <CardNote key="empty" colors={colors} text="No apps connected yet" /> : null,
  ];
}

function AppRow({
  colors,
  app,
  hint,
  on,
  onToggle,
  onOpen,
}: {
  colors: PanelProps["colors"];
  app: ConnectedApp;
  hint: string | null;
  on: boolean;
  onToggle(on: boolean): void;
  onOpen(): void;
}) {
  return (
    <PressableRow colors={colors} accessibilityLabel={`${app.name} tools and account`} onPress={onOpen}>
      {({ hovered }) => (
        <>
          <AppLogo colors={colors} app={app} />
          <RowText colors={colors} label={app.name} hint={hint} />
          <Switch colors={colors} label={`Use ${app.name}`} value={on} onValueChange={onToggle} />
          <Icon name="ChevronRight" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
        </>
      )}
    </PressableRow>
  );
}
