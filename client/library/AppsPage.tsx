import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, useRpc } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { View } from "react-native";
import type { AppCard } from "../../shared/apps";
import { matchesQuery } from "../../shared/library";
import { appsRemoveKeyRpc, appsSetKeyRpc } from "../../shared/rpc";
import { errorText } from "../native";
import { Button } from "../panel/controls";
import { InputField, SearchField } from "../panel/fields";
import { CardNote, RowText, SectionLink, SectionMeta } from "../panel/rows";
import { Alert, StatusBadge } from "../panel/status";
import { useAppsAccounts, useAppsCatalog, useAppsInvalidate, useAppsStatus } from "./apps";
import { AppLogo, DangerZone, PageTitle } from "./parts";

type Colors = PluginTheme["colors"];

/** Rows rendered at once; the catalog runs past a thousand apps, so search narrows it. */
const SHOWN = 50;
const COMPOSIO_KEYS_URL = "https://platform.composio.dev";

interface AppsPageProps {
  colors: Colors;
  showTitle: boolean;
  /** App whose sign-in is open in the browser. */
  pending: string | null;
  onConnect(slug: string): void;
}

export function AppsPage({ colors, showTitle, pending, onConnect }: AppsPageProps) {
  const status = useAppsStatus();
  return (
    <>
      {showTitle ? <PageTitle colors={colors} title="Connected apps" /> : null}
      {status.isLoading ? <CardNote colors={colors} loading text="Loading..." /> : null}
      {status.isError && !status.data ? (
        <SettingsCard>
          <SettingsRow label="Couldn't check Composio" error={errorText(status.error)} />
        </SettingsCard>
      ) : null}
      {status.data?.configured ? (
        <Catalog
          colors={colors}
          pending={pending}
          onConnect={onConnect}
          keyHint={status.data.keyHint ?? null}
        />
      ) : null}
      {status.data && !status.data.configured ? <Setup colors={colors} /> : null}
    </>
  );
}

function Setup({ colors }: { colors: Colors }) {
  const setKey = useRpc(appsSetKeyRpc);
  const invalidate = useAppsInvalidate();
  const [key, setKeyText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await setKey({ key: key.trim() });
      await invalidate();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection
      title="Composio"
      info="Composio signs you in to more than a thousand apps and gives bots their tools. It runs on your own Composio account, and the key stays on this host."
      trailing={
        <SectionLink
          colors={colors}
          icon="ArrowUpRight"
          label="Get a key"
          onPress={() => void openExternalUrl(COMPOSIO_KEYS_URL)}
        />
      }
    >
      <SettingsCard>
        <InputField
          colors={colors}
          label="Project API key"
          hint="Starts with ak_. Find it in your Composio project's settings."
          error={error}
          initialValue=""
          placeholder="ak_..."
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) => {
            setKeyText(text);
            setError(null);
          }}
        />
        <SettingsAction
          label="Connect Composio"
          hint="Checks the key and opens a session"
          actionLabel={busy ? "Connecting..." : "Connect"}
          disabled={busy || !key.trim()}
          onPress={() => void save()}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function Catalog({
  colors,
  pending,
  onConnect,
  keyHint,
}: {
  colors: Colors;
  pending: string | null;
  onConnect(slug: string): void;
  keyHint: string | null;
}) {
  const catalog = useAppsCatalog(true);
  const accounts = useAppsAccounts(true, pending !== null);
  const removeKey = useRpc(appsRemoveKeyRpc);
  const invalidate = useAppsInvalidate();
  const [query, setQuery] = useState("");
  const apps = catalog.data?.apps ?? [];
  const connected = new Set(
    (accounts.data?.accounts ?? [])
      .filter((account) => account.status === "connected")
      .map((account) => account.slug),
  );
  const matches = apps.filter((app) => matchesQuery(query, app.name, app.slug, app.description));

  return (
    <>
      <View style={{ marginBottom: 12 }}>
        <SearchField colors={colors} value={query} onChangeText={setQuery} placeholder="Search apps" />
      </View>
      {accounts.isError ? (
        <View style={{ marginBottom: 24 }}>
          <Alert
            colors={colors}
            variant="error"
            title="Couldn't load your connected apps"
            description={errorText(accounts.error)}
          />
        </View>
      ) : null}
      <SettingsSection
        title="Apps"
        trailing={
          apps.length ? (
            <SectionMeta colors={colors} text={`${apps.length.toLocaleString()} apps`} />
          ) : undefined
        }
      >
        <CatalogCard
          colors={colors}
          catalog={catalog}
          query={query}
          matches={matches}
          connected={connected}
          pending={pending}
          onConnect={onConnect}
        />
      </SettingsSection>
      <DangerZone
        label="Composio key"
        hint={keyHint ?? "Saved"}
        actionLabel="Remove"
        confirmTitle="Remove Composio key?"
        confirmMessage="Bots lose their connected apps until a key is added again. Your connections stay with your Composio account."
        onConfirm={() => void removeKey({}).then(invalidate)}
      />
    </>
  );
}

function CatalogCard({
  colors,
  catalog,
  query,
  matches,
  connected,
  pending,
  onConnect,
}: {
  colors: Colors;
  catalog: Pick<UseQueryResult, "isLoading" | "isError" | "error">;
  query: string;
  matches: AppCard[];
  connected: ReadonlySet<string>;
  pending: string | null;
  onConnect(slug: string): void;
}) {
  return (
    <SettingsCard>
      {catalog.isLoading ? <CardNote colors={colors} loading text="Loading apps..." /> : null}
      {catalog.isError ? (
        <SettingsRow
          label="Couldn't load the apps"
          error={catalog.error instanceof Error ? catalog.error.message : String(catalog.error)}
        />
      ) : null}
      {!catalog.isLoading && !catalog.isError && matches.length === 0 ? (
        <CardNote colors={colors} text={query.trim() ? `No apps match "${query.trim()}"` : "No apps"} />
      ) : null}
      {matches.slice(0, SHOWN).map((app) => (
        <CatalogRow
          key={app.slug}
          colors={colors}
          app={app}
          connected={connected.has(app.slug)}
          pending={pending}
          onConnect={onConnect}
        />
      ))}
      {matches.length > SHOWN ? (
        <CardNote
          colors={colors}
          text={`Showing ${SHOWN} of ${matches.length.toLocaleString()}. Search to find more.`}
        />
      ) : null}
    </SettingsCard>
  );
}

function CatalogRow({
  colors,
  app,
  connected,
  pending,
  onConnect,
}: {
  colors: Colors;
  app: AppCard;
  connected: boolean;
  pending: string | null;
  onConnect(slug: string): void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 16,
        minHeight: 56,
      }}
    >
      <AppLogo colors={colors} app={app} />
      <RowText colors={colors} label={app.name} hint={app.description || null} hintLines={1} />
      {connected ? (
        <StatusBadge colors={colors} label="Connected" variant="success" />
      ) : (
        <Button
          colors={colors}
          variant="outline"
          label={pending === app.slug ? "Waiting..." : "Connect"}
          loading={pending === app.slug}
          disabled={pending !== null && pending !== app.slug}
          onPress={() => onConnect(app.slug)}
        />
      )}
    </View>
  );
}
