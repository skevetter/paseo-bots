import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text, View } from "react-native";
import type { Bot, LibraryMcpServer, McpTool } from "../../shared/bot";
import { BROWSER_SERVER_ID, isBrowserServer, mcpServerLabel } from "../../shared/browser";
import { mcpServerTested, mcpTarget } from "../../shared/library";
import { mcpProbeRpc } from "../../shared/rpc";
import { relativeTime } from "../../shared/time";
import { errorText, MONO_FONT, MONO_PROPS } from "../native";
import { Button } from "../panel/controls";
import { CardNote, SectionLink, SectionMeta } from "../panel/rows";
import { Alert } from "../panel/status";
import { code, ui } from "../typography";
import { BrowserSection } from "./BrowserSection";
import { type McpDraft, ServerSheet } from "./McpSheets";
import { BotsCard, DangerZone, PageTitle } from "./parts";
import { withMember } from "./status";

type Colors = PluginTheme["colors"];

type ServerConfig = LibraryMcpServer["config"];

interface McpPageProps {
  colors: Colors;
  server: LibraryMcpServer;
  bots: Bot[];
  otherNames: string[];
  showTitle: boolean;
  testing: boolean;
  onTest(config: ServerConfig, enable?: boolean): Promise<void>;
  onPatch(patch: Partial<LibraryMcpServer>): void;
  onToggleBot(bot: Bot, on: boolean): void;
  onDelete(): void;
}

/** Keys only: values are usually secrets. */
function keysHint(server: LibraryMcpServer): string | null {
  const { config } = server;
  const keys = Object.keys(config.type === "stdio" ? config.env : config.headers);
  return keys.length ? `${config.type === "stdio" ? "Environment" : "Headers"}: ${keys.join(", ")}` : null;
}

export function McpPage({
  colors,
  server,
  bots,
  otherNames,
  showTitle,
  testing,
  onTest,
  onPatch,
  onToggleBot,
  onDelete,
}: McpPageProps) {
  const [editing, setEditing] = useState(false);
  const tested = mcpServerTested(server);

  const saveEdit = (draft: McpDraft) => {
    setEditing(false);
    const changed = JSON.stringify(draft.config) !== JSON.stringify(server.config);
    // A changed connection makes the old tool list stale; test the new one right away.
    onPatch({ ...draft, ...(changed ? { tools: null, checkError: null, checkedAt: null } : {}) });
    if (changed) void onTest(draft.config);
  };

  return (
    <>
      {showTitle ? <PageTitle colors={colors} title={mcpServerLabel(server)} /> : null}
      {!server.enabled && !tested ? (
        <TestFirstNotice colors={colors} testing={testing} onTest={() => void onTest(server.config, true)} />
      ) : null}
      {isBrowserServer(server) ? (
        <BrowserSection
          colors={colors}
          config={server.config}
          onConfig={(config) => saveEdit({ name: server.name, description: server.description, config })}
        />
      ) : null}
      <ServerSection
        server={server}
        tested={tested}
        testing={testing}
        onTestAndEnable={() => void onTest(server.config, true)}
        onPatch={onPatch}
        onEdit={() => setEditing(true)}
      />
      <ToolsSection
        colors={colors}
        server={server}
        testing={testing}
        onTest={() => void onTest(server.config)}
      />

      <BotsCard
        colors={colors}
        bots={bots}
        noun="server"
        uses={(bot) => bot.mcpServerIds.includes(server.id)}
        onToggle={onToggleBot}
      />

      {server.id === BROWSER_SERVER_ID ? null : (
        <DangerZone
          label="Delete server"
          hint="Removes it from the library and from every bot"
          actionLabel="Delete"
          confirmTitle="Delete MCP server?"
          confirmMessage={`Delete "${server.name}"? No bot will get it any more.`}
          onConfirm={onDelete}
        />
      )}

      {editing ? (
        <ServerSheet
          colors={colors}
          initial={server}
          isNew={false}
          otherNames={otherNames}
          onClose={() => setEditing(false)}
          onSave={saveEdit}
        />
      ) : null}
    </>
  );
}

export interface ServerTests {
  /** Ids of the servers being tested. */
  testing: ReadonlySet<string>;
  /** Tests the connection; `enable` turns the server on when it connects. */
  test(id: string, config: ServerConfig, enable?: boolean): Promise<void>;
}

/** Held above the page, so a running test still shows in the list and when its page reopens. */
export function useServerTests(onPatch: (id: string, patch: Partial<LibraryMcpServer>) => void): ServerTests {
  const probe = useRpc(mcpProbeRpc);
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());

  const test = async (id: string, config: ServerConfig, enable = false) => {
    setTesting((current) => withMember(current, id, true));
    try {
      const result = await probe({ config });
      const checkedAt = new Date().toISOString();
      onPatch(
        id,
        result.ok
          ? { tools: result.tools, checkError: null, checkedAt, ...(enable ? { enabled: true } : {}) }
          : { checkError: result.error, checkedAt },
      );
    } catch (error) {
      onPatch(id, { checkError: errorText(error), checkedAt: new Date().toISOString() });
    } finally {
      setTesting((current) => withMember(current, id, false));
    }
  };

  return { testing, test };
}

function TestFirstNotice({ colors, testing, onTest }: { colors: Colors; testing: boolean; onTest(): void }) {
  return (
    <View style={{ marginBottom: 24, gap: 12 }}>
      <Alert
        colors={colors}
        variant="warning"
        title="Test before bots use it"
        description="New servers arrive switched off. The test starts it on this host and lists its tools; it turns on once it connects."
      />
      <View style={{ alignItems: "flex-start" }}>
        <Button
          colors={colors}
          variant="outline"
          icon="PlugZap"
          label={testing ? "Testing..." : "Test and turn on"}
          disabled={testing}
          onPress={onTest}
        />
      </View>
    </View>
  );
}

function ServerSection({
  server,
  tested,
  testing,
  onTestAndEnable,
  onPatch,
  onEdit,
}: {
  server: LibraryMcpServer;
  tested: boolean;
  testing: boolean;
  onTestAndEnable(): void;
  onPatch: McpPageProps["onPatch"];
  onEdit(): void;
}) {
  return (
    <SettingsSection title="Server">
      <SettingsCard>
        <SettingsSwitch
          label="Enabled"
          hint={tested ? "When off, no bot gets this server" : "Test it to turn it on"}
          value={server.enabled}
          disabled={testing}
          onValueChange={(enabled) => (enabled && !tested ? onTestAndEnable() : onPatch({ enabled }))}
        />
        <SettingsAction
          label="Connection"
          hint={[mcpTarget(server.config), keysHint(server)].filter(Boolean).join("\n")}
          actionLabel="Edit"
          onPress={onEdit}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

function toolsMeta(server: LibraryMcpServer, testing: boolean): string {
  if (testing) return "Connecting...";
  if (!server.checkedAt) return "";
  return `${server.tools ? `${server.tools.length} tools · ` : ""}checked ${relativeTime(server.checkedAt)}`;
}

function ToolsSection({
  colors,
  server,
  testing,
  onTest,
}: {
  colors: Colors;
  server: LibraryMcpServer;
  testing: boolean;
  onTest(): void;
}) {
  const meta = toolsMeta(server, testing);
  return (
    <SettingsSection
      title="Tools"
      info={
        'Connects the way an agent would and lists what the server offers. Use these names for "Always allowed" in a bot\'s Access settings.'
      }
      trailing={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {meta ? <SectionMeta colors={colors} text={meta} /> : null}
          {testing ? null : (
            <SectionLink
              colors={colors}
              icon="RefreshCw"
              label={server.checkedAt ? "Test again" : "Test connection"}
              onPress={onTest}
            />
          )}
        </View>
      }
    >
      <ToolsCard colors={colors} server={server} testing={testing} />
    </SettingsSection>
  );
}

function ToolsCard({
  colors,
  server,
  testing,
}: {
  colors: Colors;
  server: LibraryMcpServer;
  testing: boolean;
}) {
  return (
    <SettingsCard>
      {testing ? (
        <CardNote colors={colors} loading text="Starting the server and listing its tools..." />
      ) : null}
      {!testing && server.checkError ? (
        <SettingsRow label="Couldn't connect" error={server.checkError} />
      ) : null}
      {!testing && !server.checkError && server.tools === null ? (
        <CardNote colors={colors} text="Test the connection to see this server's tools" />
      ) : null}
      {!testing && !server.checkError && server.tools?.length === 0 ? (
        <CardNote colors={colors} text="The server lists no tools" />
      ) : null}
      {!testing && !server.checkError
        ? (server.tools ?? []).map((tool) => (
            <ToolRow key={tool.name} colors={colors} serverName={server.name} tool={tool} />
          ))
        : null}
    </SettingsCard>
  );
}

function ToolRow({ colors, serverName, tool }: { colors: Colors; serverName: string; tool: McpTool }) {
  return (
    <View style={{ paddingVertical: 12, paddingHorizontal: 16, gap: 4 }}>
      <Text
        selectable
        numberOfLines={1}
        {...MONO_PROPS}
        style={{ fontFamily: MONO_FONT, fontSize: code(), color: colors.foreground }}
      >
        {serverName}/{tool.name}
      </Text>
      {tool.description ? (
        <Text numberOfLines={2} style={{ fontSize: ui(12), color: colors.foregroundMuted }}>
          {tool.description}
        </Text>
      ) : null}
    </View>
  );
}
