import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { type ReactNode, useRef } from "react";
import { ActivityIndicator, type LayoutRectangle, Pressable, Text, View } from "react-native";
import type { AppAccount } from "../../shared/apps";
import type { Library, LibraryMcpServer, LibrarySkill } from "../../shared/bot";
import { mcpServerLabel } from "../../shared/browser";
import { matchesQuery, mcpTarget } from "../../shared/library";
import { nativeTokens, useHover } from "../native";
import type { LibraryTarget } from "../navigation";
import { SearchField } from "../panel/controls";
import { ui } from "../typography";
import { measureAnchor } from "../ui/Menu";
import { tooltip } from "../ui/Tooltip";
import { connectedApps, useAppsAccounts, useAppsCatalog, useAppsStatus } from "./apps";
import { AppLogo } from "./parts";
import { type ListNote, mcpServerNote } from "./status";

type Colors = PluginTheme["colors"];

interface LibraryListProps {
  colors: Colors;
  library: Library;
  query: string;
  onQuery(query: string): void;
  /** Highlighted row; null on compact, where the list is its own screen. */
  selected: LibraryTarget | null;
  onSelect(target: LibraryTarget): void;
  onAddSkill(anchor: LayoutRectangle): void;
  onAddServer(anchor: LayoutRectangle): void;
  /** Ids of the MCP servers being tested. */
  testingServers: ReadonlySet<string>;
  touch: boolean;
  onBack?(): void;
  bottomInset: number;
}

export function LibraryList({
  colors,
  library,
  query,
  onQuery,
  selected,
  onSelect,
  onAddSkill,
  onAddServer,
  testingServers,
  touch,
  onBack,
  bottomInset,
}: LibraryListProps) {
  const searching = query.trim().length > 0;
  const rows = { colors, searching, touch, selected, onSelect };

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingBottom: 16 + bottomInset }}
    >
      <ListHeader colors={colors} query={query} onQuery={onQuery} touch={touch} onBack={onBack} />
      <SkillsGroup {...rows} skills={library.skills} query={query} onAdd={onAddSkill} />
      <Divider colors={colors} />
      <ServersGroup
        {...rows}
        servers={library.mcpServers}
        testing={testingServers}
        query={query}
        onAdd={onAddServer}
      />
      <Divider colors={colors} />
      <AppsGroup {...rows} query={query} />
    </ScrollView>
  );
}

interface GroupRowsProps {
  colors: Colors;
  query: string;
  searching: boolean;
  touch: boolean;
  selected: LibraryTarget | null;
  onSelect(target: LibraryTarget): void;
}

function isSelected(selected: LibraryTarget | null, kind: LibraryTarget["kind"], id?: string): boolean {
  return selected?.kind === kind && (id === undefined || ("id" in selected && selected.id === id));
}

function ListHeader({
  colors,
  query,
  onQuery,
  touch,
  onBack,
}: {
  colors: Colors;
  query: string;
  onQuery(query: string): void;
  touch: boolean;
  onBack?(): void;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 8,
        paddingTop: 8,
        paddingBottom: 8,
        gap: 2,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      {onBack ? (
        <NavRow
          colors={colors}
          icon="ArrowLeft"
          label="Back to bots"
          selected={false}
          touch={touch}
          onPress={onBack}
        />
      ) : null}
      <SearchField
        colors={colors}
        value={query}
        onChangeText={onQuery}
        placeholder="Search skills and tools"
      />
    </View>
  );
}

function skillNote(skill: LibrarySkill): ListNote | undefined {
  if (skill.reviewedSha === null) return { text: "Review" };
  return skill.enabled ? undefined : { text: "Off" };
}

function SkillsGroup({
  colors,
  query,
  searching,
  touch,
  selected,
  onSelect,
  skills,
  onAdd,
}: GroupRowsProps & { skills: readonly LibrarySkill[]; onAdd(anchor: LayoutRectangle): void }) {
  const shown = skills
    .filter((skill) => matchesQuery(query, skill.id, skill.description, skill.source))
    .sort((a, b) => a.id.localeCompare(b.id));
  return (
    <Group colors={colors} label="Skills" addLabel="Add skill" onAdd={onAdd}>
      {shown.map((skill) => (
        <NavRow
          key={skill.id}
          colors={colors}
          icon="Puzzle"
          label={skill.id}
          note={skillNote(skill)}
          selected={isSelected(selected, "skill", skill.id)}
          touch={touch}
          onPress={() => onSelect({ kind: "skill", id: skill.id })}
        />
      ))}
      {shown.length === 0 ? (
        <GroupNote colors={colors} text={searching ? "No matching skills" : "No skills yet"} />
      ) : null}
    </Group>
  );
}

function ServersGroup({
  colors,
  query,
  searching,
  touch,
  selected,
  onSelect,
  servers,
  testing,
  onAdd,
}: GroupRowsProps & {
  servers: readonly LibraryMcpServer[];
  testing: ReadonlySet<string>;
  onAdd(anchor: LayoutRectangle): void;
}) {
  const shown = servers
    .filter((server) =>
      matchesQuery(query, mcpServerLabel(server), server.name, server.description, mcpTarget(server.config)),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Group colors={colors} label="MCP servers" addLabel="Add MCP server" onAdd={onAdd}>
      {shown.map((server) => (
        <NavRow
          key={server.id}
          colors={colors}
          icon="Plug"
          label={mcpServerLabel(server)}
          note={mcpServerNote(server, testing.has(server.id))}
          selected={isSelected(selected, "mcp", server.id)}
          touch={touch}
          onPress={() => onSelect({ kind: "mcp", id: server.id })}
        />
      ))}
      {shown.length === 0 ? (
        <GroupNote colors={colors} text={searching ? "No matching servers" : "No MCP servers yet"} />
      ) : null}
    </Group>
  );
}

const APP_NOTES: Record<AppAccount["status"], ListNote | undefined> = {
  connected: undefined,
  pending: { text: "Pending" },
  failed: { text: "Failed" },
};

function appsEmptyText(searching: boolean, configured: boolean): string {
  if (searching) return "No matching apps";
  return configured ? "No apps connected yet" : "Not set up yet";
}

function AppsGroup({ colors, query, searching, touch, selected, onSelect }: GroupRowsProps) {
  const appsStatus = useAppsStatus();
  const configured = appsStatus.data?.configured ?? false;
  const accounts = useAppsAccounts(configured);
  const catalog = useAppsCatalog(configured);
  const apps = connectedApps(accounts.data?.accounts ?? [], catalog.data?.apps ?? []).filter((app) =>
    matchesQuery(query, app.name, app.slug),
  );
  return (
    <Group
      colors={colors}
      label="Connected apps"
      addLabel={configured ? "Connect an app" : "Set up connected apps"}
      onAdd={() => onSelect({ kind: "apps" })}
    >
      {apps.map((app) => (
        <NavRow
          key={app.slug}
          colors={colors}
          icon="AppWindow"
          leading={<AppLogo colors={colors} app={app} size={16} />}
          label={app.name}
          note={APP_NOTES[app.status]}
          selected={isSelected(selected, "app", app.slug)}
          touch={touch}
          onPress={() => onSelect({ kind: "app", id: app.slug })}
        />
      ))}
      {apps.length === 0 ? <GroupNote colors={colors} text={appsEmptyText(searching, configured)} /> : null}
    </Group>
  );
}

function Group({
  colors,
  label,
  addLabel,
  onAdd,
  children,
}: {
  colors: Colors;
  label: string;
  addLabel: string;
  onAdd(anchor: LayoutRectangle): void;
  children: ReactNode;
}) {
  const tokens = nativeTokens(colors);
  return (
    <View style={{ paddingVertical: 8, paddingHorizontal: 8, gap: 2 }}>
      <View
        style={{ flexDirection: "row", alignItems: "center", paddingLeft: 8, paddingRight: 4, minHeight: 28 }}
      >
        <Text style={{ flex: 1, fontSize: ui(14), color: tokens.foregroundExtraMuted }}>{label}</Text>
        <AddButton colors={colors} label={addLabel} onPress={onAdd} />
      </View>
      {children}
    </View>
  );
}

function Divider({ colors }: { colors: Colors }) {
  return <View style={{ height: 1, backgroundColor: colors.border }} />;
}

function GroupNote({ colors, text }: { colors: Colors; text: string }) {
  return (
    <Text
      style={{ fontSize: ui(14), color: colors.foregroundMuted, paddingHorizontal: 8, paddingVertical: 4 }}
    >
      {text}
    </Text>
  );
}

function AddButton({
  colors,
  label,
  onPress,
}: {
  colors: Colors;
  label: string;
  onPress(anchor: LayoutRectangle): void;
}) {
  const ref = useRef<View>(null);
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...tooltip(label, "bottom")}
      hitSlop={8}
      onPress={() => void measureAnchor(ref).then((anchor) => anchor && onPress(anchor))}
      {...hoverProps}
      style={({ pressed }) => ({
        width: 24,
        height: 24,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: hovered || pressed ? colors.surface1 : "transparent",
      })}
    >
      <Icon name="Plus" size={14} color={hovered ? colors.foreground : colors.foregroundMuted} />
    </Pressable>
  );
}

interface NavRowProps {
  colors: Colors;
  icon: string;
  label: string;
  /** Replaces the icon. */
  leading?: ReactNode;
  /** A plain note also mutes the label. */
  note?: ListNote;
  selected: boolean;
  touch: boolean;
  onPress(): void;
}

function NavRow({ colors, icon, leading, label, note, selected, touch, onPress }: NavRowProps) {
  const { hovered, hoverProps } = useHover();
  const strong = selected || hovered;
  const tint = strong ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={note ? `${label}, ${note.text}` : label}
      accessibilityState={{ selected }}
      onPress={onPress}
      {...hoverProps}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: touch ? 36 : 28,
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: strong || pressed ? colors.surface1 : "transparent",
      })}
    >
      {leading ?? <Icon name={icon} size={16} color={tint} />}
      <Text
        numberOfLines={1}
        style={{ flex: 1, minWidth: 0, fontSize: ui(14), color: tint, opacity: note && !note.tone ? 0.6 : 1 }}
      >
        {label}
      </Text>
      {note ? <NavNote colors={colors} note={note} /> : null}
    </Pressable>
  );
}

function NavNote({ colors, note }: { colors: Colors; note: ListNote }) {
  const color = note.tone === "danger" ? colors.statusDanger : colors.foregroundMuted;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {note.tone === "busy" ? <ActivityIndicator size="small" color={colors.foregroundMuted} /> : null}
      <Text style={{ fontSize: ui(12), color }}>{note.text}</Text>
    </View>
  );
}
