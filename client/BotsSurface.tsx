import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { ActivityIndicator, type LayoutRectangle, Text, View } from "react-native";
import type { Bot, BotGroup, Library } from "../shared/bot";
import { SETUP_PROMPT, syncBotWorkspaceTitle } from "../shared/chat";
import type { TeamTab } from "../shared/groups";
import type { PolicyState } from "../shared/policies";
import { ensureBotHomeRpc } from "../shared/rpc";
import { newUuid } from "../shared/uuid";
import { AvatarTheme } from "./Avatar";
import { autoStarter, withoutStart } from "./autoStart";
import { ExportDialog, NewBotDialog, RenameDialog } from "./BotDialogs";
import { BotSidebar } from "./BotSidebar";
import {
  commitWidth,
  createBot,
  deleteTeam,
  importBots,
  openBotMenu,
  openBotMenuFromPane,
  openChatMenu,
  openDisplayMenu,
  openFleet,
  openTeamMenu,
  renameBot,
  type SurfaceContext,
  saveTeamDraft,
  select,
  surfaceContext,
} from "./botsSurfaceActions";
import { ChatPane } from "./ChatPane";
import { type ChatStartFeedback, ChatStartNotices, useChatStartFeedback } from "./chat/LocalStartNotice";
import { type StartChat, useStartChat } from "./chat/useStartChat";
import { type BotHost, type LocalHost, useBotHost } from "./data";
import { FleetPage } from "./fleet/FleetPage";
import { LibraryView } from "./library/LibraryView";
import { errorText, nativeTokens } from "./native";
import { BotPanel } from "./panel/BotPanel";
import { Button } from "./panel/controls";
import { Splash } from "./Splash";
import type { Selection } from "./sidebar/types";
import { TeamMap } from "./teams/TeamMap";
import { TeamSheet } from "./teams/TeamSheet";
import { TeamTabSwitcher, TeamTabsRow } from "./teams/TeamTabs";
import { ui } from "./typography";
import { ResizeHandle, SlideOver } from "./ui/Columns";
import { MenuProvider } from "./ui/Menu";
import { useTooltipTheme } from "./ui/Tooltip";
import type { BotStoreState } from "./useBotState";
import { useBotsSurface } from "./useBotsSurface";
import { useChat } from "./useChat";

type Colors = PluginTheme["colors"];

export function BotsSurface(props: PluginScreenProps) {
  const { colors } = props.theme;
  useTooltipTheme(colors);
  return (
    <MenuProvider colors={colors} compact={props.layout.compact}>
      <AvatarTheme dark={nativeTokens(colors).dark}>
        <BotsSurfaceContent {...props} />
      </AvatarTheme>
    </MenuProvider>
  );
}

function BotsSurfaceContent(props: PluginScreenProps) {
  const model = useBotsSurface(props);
  const { settings } = model;
  if (settings.status !== "ready") return <SettingsUnavailable colors={model.colors} settings={settings} />;
  return <BotsScreen ctx={surfaceContext(model, settings.values)} />;
}

function SettingsUnavailable({
  colors,
  settings,
}: {
  colors: Colors;
  settings: Exclude<BotStoreState, { status: "ready" }>;
}) {
  const loading = settings.status === "loading";
  return (
    <View
      style={{
        flex: 1,
        padding: 24,
        gap: 12,
        backgroundColor: colors.surface0,
        justifyContent: loading ? "center" : "flex-start",
        alignItems: loading ? "center" : "stretch",
      }}
    >
      {settings.status === "loading" ? (
        <ActivityIndicator size="large" color={colors.foregroundMuted} accessibilityLabel="Loading bots" />
      ) : (
        <Text style={{ fontSize: ui(14), color: colors.statusDanger }}>
          Couldn't read bots: {settings.error}
        </Text>
      )}
    </View>
  );
}

interface TeamTabProps {
  colors: Colors;
  tabs: TeamTab[];
  openTab: TeamTab;
  onTab(tab: string): void;
  onTeamMenu(group: BotGroup, anchor: LayoutRectangle): void;
  onNewTeam(): void;
}

interface ScreenParts {
  sidebar: ReactElement;
  tabProps: TeamTabProps | null;
  pane: ReactElement;
  settingsPanel: ReactElement | null;
  libraryScreen: ReactElement | null;
}

function renderSidebar(ctx: SurfaceContext): ReactElement {
  const { colors, layout, listUi, archivedCount, updateUi } = ctx;
  return (
    <BotSidebar
      colors={colors}
      bots={ctx.listed}
      openTab={ctx.openTab}
      hiddenArchivedCount={listUi.showArchived ? 0 : archivedCount}
      selection={ctx.selection}
      ui={listUi}
      localHost={ctx.localHost}
      touch={layout.compact || layout.platform !== "web"}
      splash={layout.compact}
      bottomInset={ctx.bottomInset}
      query={ctx.botQuery}
      onQueryChange={ctx.setBotQuery}
      onToggle={(botId) =>
        updateUi((current) => ({
          ...current,
          collapsed: current.collapsed.includes(botId)
            ? current.collapsed.filter((id) => id !== botId)
            : [...current.collapsed, botId],
        }))
      }
      onTogglePinnedSection={() =>
        updateUi((current) => ({ ...current, pinnedCollapsed: !current.pinnedCollapsed }))
      }
      onShowArchived={() => updateUi((current) => ({ ...current, showArchived: true }))}
      onSelect={(next) => select(ctx, next)}
      onNewBot={() => ctx.setCreating(true)}
      onBotMenu={(bot, anchor, source) => openBotMenu(ctx, bot, anchor, source)}
      onChatMenu={(request) => openChatMenu(ctx, request)}
      onDisplayMenu={(anchor) => openDisplayMenu(ctx, anchor)}
      onEditTeam={ctx.setEditingTeam}
      onTeamMap={() => {
        ctx.setFleet(false);
        ctx.setTeamMap(true);
      }}
      onFleet={() => void openFleet(ctx)}
    />
  );
}

function teamTabProps(ctx: SurfaceContext): TeamTabProps | null {
  const { openTab } = ctx;
  return openTab
    ? {
        colors: ctx.colors,
        tabs: ctx.tabs,
        openTab,
        onTab: (tab) => ctx.updateUi((current) => ({ ...current, tab })),
        onTeamMenu: (group, anchor) => openTeamMenu(ctx, group, anchor),
        onNewTeam: () => ctx.setEditingTeam("new"),
      }
    : null;
}

function renderTeamMap(ctx: SurfaceContext): ReactElement {
  const { layout } = ctx;
  return (
    <TeamMap
      colors={ctx.colors}
      groups={ctx.groups}
      bots={ctx.allBots}
      localHost={ctx.localHost}
      compact={layout.compact}
      bottomInset={ctx.bottomInset}
      onBack={layout.compact ? () => ctx.setTeamMap(false) : undefined}
      onNewTeam={() => ctx.setEditingTeam("new")}
      onEditTeam={ctx.setEditingTeam}
      onOpenBot={(bot) => {
        select(ctx, { botId: bot.id, chatId: null });
        ctx.setPanel({ open: true, section: "overview" });
      }}
    />
  );
}

function renderPane(ctx: SurfaceContext, feedback: ChatStartFeedback): ReactElement {
  const { selectedBot, selection, layout, panel } = ctx;
  if (ctx.teamMap) return renderTeamMap(ctx);
  if (ctx.fleet) {
    if (Object.keys(ctx.drafts).length > 0)
      return (
        <View style={{ padding: 24, gap: 12 }}>
          <Text accessibilityRole="alert" style={{ color: ctx.colors.statusDanger }}>
            Save pending bot edits before changing fleet settings. Unsaved drafts cannot overwrite a bulk
            operation.
          </Text>
          <Button colors={ctx.colors} label="Retry saving bot edits" onPress={() => void ctx.flush()} />
          <Button colors={ctx.colors} label="Back to bots" onPress={() => ctx.setFleet(false)} />
        </View>
      );
    return <FleetPage colors={ctx.colors} compact={layout.compact} onClose={() => ctx.setFleet(false)} />;
  }
  if (!selectedBot || !selection) return <Splash colors={ctx.colors} />;
  return (
    <SelectedChat
      key={`${selectedBot.id}:${selection.chatId ?? "new"}`}
      colors={ctx.colors}
      bot={selectedBot}
      library={ctx.library}
      policy={ctx.values}
      selection={selection}
      localHost={ctx.localHost}
      panelOpen={panel.open}
      layout={layout}
      keyboardOpen={ctx.keyboardHeight > 0}
      typeVersion={ctx.typeVersion}
      onBack={layout.compact ? () => ctx.setSelection(null) : undefined}
      onBotMenu={(anchor) =>
        anchor ? openBotMenu(ctx, selectedBot, anchor, "kebab") : openBotMenuFromPane(ctx, selectedBot)
      }
      onTogglePanel={() => ctx.setPanel({ open: !panel.open, section: panel.section })}
      onStarted={(chatId) => ctx.setSelection({ botId: selectedBot.id, chatId })}
      feedback={feedback}
      flush={ctx.flush}
      hasDraft={ctx.hasDraft}
      onStartHandled={(id) => ctx.setSelection((current) => withoutStart(current, id))}
    />
  );
}

function renderSettingsPanel(ctx: SurfaceContext): ReactElement | null {
  const { selectedBot, panel, layout } = ctx;
  if (ctx.fleet || !selectedBot || !panel.open) return null;
  return (
    <BotPanel
      key={`${selectedBot.id}:${ctx.panelVersion}`}
      colors={ctx.colors}
      compact={layout.compact}
      bottomInset={ctx.bottomInset}
      bot={selectedBot}
      localHost={ctx.localHost}
      history={ctx.values.history}
      library={ctx.library}
      groups={ctx.groups}
      section={panel.section}
      onSection={(section) => ctx.setPanel({ open: true, section })}
      onClose={() => ctx.setPanel({ open: false, section: panel.section })}
      onPatch={(patch) => ctx.patchBot(selectedBot.id, patch)}
      flush={async () => {
        await ctx.flush();
      }}
      onRestore={(snapshot) => {
        ctx.patchBot(selectedBot.id, snapshot);
        ctx.setPanelVersion((version) => version + 1);
        ctx.toast.show("Restored. Undo it from History if needed.", { variant: "success" });
      }}
      onSetup={() => {
        select(ctx, {
          botId: selectedBot.id,
          chatId: null,
          start: { id: newUuid(), prompt: SETUP_PROMPT, purpose: "maintenance" },
        });
        // On phones the panel covers the chat.
        if (layout.compact) ctx.setPanel({ open: false, section: panel.section });
      }}
      onOpenChat={(chatId) => {
        select(ctx, { botId: selectedBot.id, chatId });
        // On phones the panel covers the chat.
        if (layout.compact) ctx.setPanel({ open: false, section: panel.section });
      }}
    />
  );
}

function renderLibrary(ctx: SurfaceContext): ReactElement | null {
  const { libraryView } = ctx;
  if (!libraryView) return null;
  return (
    <LibraryView
      colors={ctx.colors}
      layout={ctx.layout}
      bottomInset={ctx.bottomInset}
      values={ctx.values}
      commit={ctx.commit}
      target={libraryView.target}
      onTarget={(target) => ctx.setLibraryView({ target })}
      onBack={() => ctx.setLibraryView(null)}
    />
  );
}

function renderCompact(ctx: SurfaceContext, parts: ScreenParts): ReactElement {
  const { teamMap, panel } = ctx;
  return (
    <View ref={ctx.paneRef} collapsable={false} style={{ flex: 1 }}>
      {parts.tabProps ? <TeamTabSwitcher {...parts.tabProps} /> : null}
      {parts.sidebar}
      {ctx.selection || teamMap || ctx.fleet ? (
        <SlideOver
          onClose={() =>
            ctx.fleet ? ctx.setFleet(false) : teamMap ? ctx.setTeamMap(false) : ctx.setSelection(null)
          }
        >
          {parts.pane}
        </SlideOver>
      ) : null}
      {parts.settingsPanel ? (
        <SlideOver
          onClose={() => ctx.setPanel({ open: false, section: null })}
          onBack={() => (panel.section ? ctx.goBack() : false)}
        >
          {parts.settingsPanel}
        </SlideOver>
      ) : null}
      {parts.libraryScreen ? (
        <SlideOver onClose={() => ctx.setLibraryView(null)}>{parts.libraryScreen}</SlideOver>
      ) : null}
    </View>
  );
}

function renderDesktop(ctx: SurfaceContext, parts: ScreenParts): ReactElement {
  const { colors, columns, setDragWidths } = ctx;
  return (
    <>
      {parts.tabProps ? <TeamTabsRow {...parts.tabProps} /> : null}
      <View style={{ flex: 1, flexDirection: "row" }}>
        <View
          style={{
            width: columns.list,
            borderRightWidth: 1,
            borderRightColor: colors.border,
            backgroundColor: nativeTokens(colors).surfaceSidebar,
          }}
        >
          {parts.sidebar}
          <ResizeHandle
            side="right"
            width={columns.list}
            onResize={(width) => setDragWidths((current) => ({ ...current, list: width }))}
            onCommit={(width) => commitWidth(ctx, "listWidth", width)}
          />
        </View>
        <View ref={ctx.paneRef} collapsable={false} style={{ flex: 1, minWidth: 0 }}>
          {parts.pane}
        </View>
        {parts.settingsPanel && columns.panel !== null ? (
          <View style={{ width: columns.panel, borderLeftWidth: 1, borderLeftColor: colors.border }}>
            {parts.settingsPanel}
            <ResizeHandle
              side="left"
              width={columns.panel}
              onResize={(width) => setDragWidths((current) => ({ ...current, panel: width }))}
              onCommit={(width) => commitWidth(ctx, "panelWidth", width)}
            />
          </View>
        ) : null}
      </View>
    </>
  );
}

function renderTeamSheet(ctx: SurfaceContext): ReactElement | null {
  const { editingTeam } = ctx;
  if (!editingTeam) return null;
  return (
    <TeamSheet
      colors={ctx.colors}
      group={editingTeam === "new" ? null : editingTeam}
      groups={ctx.groups}
      bots={ctx.allBots}
      onClose={() => ctx.setEditingTeam(null)}
      onSave={(draft) => saveTeamDraft(ctx, editingTeam, draft)}
      onDelete={
        editingTeam === "new"
          ? undefined
          : () => void deleteTeam(ctx, editingTeam).then((deleted) => deleted && ctx.setEditingTeam(null))
      }
    />
  );
}

function renderNewBotDialog(ctx: SurfaceContext): ReactElement | null {
  if (!ctx.creating) return null;
  return (
    <NewBotDialog
      colors={ctx.colors}
      onClose={() => ctx.setCreating(false)}
      presets={ctx.values.presets ?? []}
      onCreate={(start) => createBot(ctx, start)}
      onImport={(json) => importBots(ctx, json)}
    />
  );
}

function renderRenameDialog(ctx: SurfaceContext): ReactElement | null {
  const { renaming } = ctx;
  if (!renaming) return null;
  return (
    <RenameDialog
      colors={ctx.colors}
      title="Rename bot"
      initialValue={renaming.name}
      placeholder={renaming.name}
      onClose={() => ctx.setRenaming(null)}
      onSubmit={(name) => renameBot(ctx, renaming, name)}
    />
  );
}

function BotsScreen({ ctx }: { ctx: SurfaceContext }) {
  const feedback = useChatStartFeedback();
  const { colors, layout, keyboardHeight } = ctx;
  const parts: ScreenParts = {
    sidebar: renderSidebar(ctx),
    tabProps: teamTabProps(ctx),
    pane: renderPane(ctx, feedback),
    settingsPanel: renderSettingsPanel(ctx),
    libraryScreen: renderLibrary(ctx),
  };

  if (parts.libraryScreen && !layout.compact) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}>
        {parts.libraryScreen}
      </View>
    );
  }

  return (
    <>
      {/* The host gives plugin surfaces no keyboard handling; lift everything above the keyboard. */}
      <View
        style={{ flex: 1, backgroundColor: colors.surface0, paddingBottom: keyboardHeight }}
        onLayout={(event) => ctx.setSurfaceWidth(event.nativeEvent.layout.width)}
      >
        {layout.compact ? renderCompact(ctx, parts) : renderDesktop(ctx, parts)}
        {renderTeamSheet(ctx)}
        {renderNewBotDialog(ctx)}

        {renderRenameDialog(ctx)}

        {ctx.exporting ? (
          <ExportDialog colors={colors} bot={ctx.exporting} onClose={() => ctx.setExporting(null)} />
        ) : null}
      </View>
    </>
  );
}

interface SelectedChatProps {
  colors: Colors;
  bot: Bot;
  library: Library;
  policy: PolicyState;
  selection: Selection;
  localHost: LocalHost;
  panelOpen: boolean;
  layout: PluginSurfaceProps["layout"];
  keyboardOpen: boolean;
  typeVersion: number;
  onBack?(): void;
  onBotMenu(anchor: LayoutRectangle | null): void;
  onTogglePanel(): void;
  onStarted(chatId: string): void;
  onStartHandled(id: string): void;
  feedback: ChatStartFeedback;
  flush(): Promise<boolean>;
  hasDraft(botId: string): boolean;
}
function useWorkspaceTitle(bot: Bot, host: BotHost) {
  const ensureHome = useRpc(ensureBotHomeRpc);
  const latest = useRef({ bot, ensureHome });
  latest.current = { bot, ensureHome };
  const name = bot.name;
  const hostApi = host.api;
  useEffect(() => {
    const { bot: current, ensureHome: ensure } = latest.current;
    if (!hostApi || current.cwd || !name.trim()) return;
    const timer = setTimeout(() => {
      void ensure({ botId: current.id })
        .then((home) => syncBotWorkspaceTitle(hostApi, current, { path: home.path, projectRoot: home.root }))
        .catch(() => {});
    }, 1000);
    return () => clearTimeout(timer);
    // Only the name matters here.
  }, [name, hostApi]);
}

function useAutoStart(selection: Selection, host: BotHost, start: StartChat, clear: (id: string) => void) {
  const toast = useToast();
  const latest = useRef({ start, clear, toast });
  latest.current = { start, clear, toast };
  const [offer] = useState(() =>
    autoStarter({
      start: (request) =>
        latest.current.start(
          { text: request.prompt, messageId: request.id, images: [], attachments: [] },
          request.purpose ?? "task",
        ),
      clear: (id) => latest.current.clear(id),
      onError: (error) => latest.current.toast.error(`Couldn't start: ${errorText(error)}`),
    }),
  );
  const ready = host.api !== null;
  useEffect(() => offer(selection, ready), [offer, selection, ready]);
}

function SelectedChat({
  colors,
  bot,
  library,
  policy,
  selection,
  localHost,
  panelOpen,
  layout,
  keyboardOpen,
  typeVersion,
  onBack,
  onBotMenu,
  onTogglePanel,
  onStarted,
  onStartHandled,
  feedback,
  flush,
  hasDraft,
}: SelectedChatProps) {
  const host = useBotHost(bot.hostId, localHost);
  const chat = useChat(host.api, selection.chatId);
  const start = useStartChat({ bot, library, policy, host, onStarted, feedback, flush, hasDraft });
  useWorkspaceTitle(bot, host);
  useAutoStart(selection, host, start, onStartHandled);

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <ChatStartNotices
        colors={colors}
        botId={bot.id}
        host={host}
        compact={layout.compact}
        feedback={feedback}
        onStarted={onStarted}
        flush={flush}
        hasDraft={hasDraft}
      />
      <ChatPane
        colors={colors}
        bot={bot}
        host={host}
        chat={chat}
        chatId={selection.chatId}
        panelOpen={panelOpen}
        layout={layout}
        keyboardOpen={keyboardOpen}
        typeVersion={typeVersion}
        onBack={onBack}
        onBotMenu={onBotMenu}
        onTogglePanel={onTogglePanel}
        onStart={start}
        onOpenChat={onStarted}
      />
    </View>
  );
}
